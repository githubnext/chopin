import { expect, test } from "bun:test";
import { PostgresStorage } from "./adapter";
import * as Service from "../../plan/service";
import * as room from "../../plan/room";
import {
	clientEdit,
	clientPeer,
	request,
	submitClientUpdate,
} from "../../document-development/provenance.test-fixtures";
import { reconcile } from "../../document-development/reconcile";
import { recoveryConflicts, resolveRecovery } from "../../document-development/recovery-actions";
import { initial } from "../../document-development/state";

import type { Server } from "bun";
import type { SocketData } from "../../wire";

let database = process.env.TEST_DATABASE_URL;

type Context = { plan: Service.Plan; reopen: () => Promise<void> };
async function withDocument(run: (context: Context) => Promise<void>): Promise<void> {
	let storage = new PostgresStorage(database!);
	await storage.migrate();
	let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("writer lease unavailable");
	let context: Context | undefined;
	let server = { publish: () => 0 } as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal(error) {
			throw error;
		},
	};
	try {
		let now = new Date();
		let user = crypto.randomUUID();
		let id = crypto.randomUUID();
		await storage.users.put({ id: user, login: "provenance-test", avatarUrl: "", now });
		await storage.channels.create({
			id,
			repositoryId: crypto.randomUUID(),
			repositoryOwner: "test",
			repositoryName: "provenance",
			title: "Provenance",
			createdBy: user,
			now,
			initial: await Service.initial("# Notes\n\nA draft observation.\n"),
		});
		let plan = await Service.open(id, backend, server);
		context = {
			plan,
			async reopen() {
				await Service.close(context!.plan);
				context!.plan = await Service.open(id, backend, server);
			},
		};
		let hash = room.digests(plan.document)[1]!;
		plan.documentDevelopment = {
			...initial(),
			passages: [{
				id: "passage-1",
				generatedDigest: hash,
				sourceIds: ["m1"],
				status: "generated",
				anchor: room.anchorAt(plan.document, 1, hash),
			}],
		};
		await Service.persist(plan);
		await run(context);
	} finally {
		if (context) await Service.close(context.plan);
		await storage.leases.release(lease);
		await storage.close();
	}
}

if (database) {
	test("PostgreSQL restores synthesis receipts and permanent human ownership", async () => {
		await withDocument(async context => {
			let input = request(context.plan);
			await reconcile(context.plan, input, () => true);
			await clientEdit(context.plan, { index: 1, text: "A human correction." });
			await context.reopen();
			expect(context.plan.documentDevelopment!.lastJobId).toBe(input.jobId);
			expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("protected");
			await clientEdit(context.plan, { index: 1, text: "A more useful draft." });
			expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("protected");
			expect((await reconcile(context.plan, input, () => true)).status).toBe("repeated");
		});
	}, 30_000);

	test(
		"PostgreSQL retains late human edits and exact recovery versions through reopening",
		async () => {
			await withDocument(async context => {
				let peer = await clientPeer(context.plan);
				try {
					await reconcile(context.plan, request(context.plan), () => true);
					await context.reopen();
					let first = await peer.update({ index: 1, text: "The full saved human sentence." });
					let frames: string[] = [];
					await submitClientUpdate(context.plan, first, true, frames);
					expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(true);
					expect(room.project(context.plan.document)).toContain("The full saved human sentence.");
					expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("protected");
					let second = await peer.update({
						index: 1,
						text: "The full saved human sentence continues.",
					});
					await submitClientUpdate(context.plan, second);
					let pending = recoveryConflicts(context.plan)[0]!;
					expect(pending.source).toContain("The full saved human sentence continues.");
					await context.reopen();
					expect(recoveryConflicts(context.plan)).toEqual([pending]);
					expect(await resolveRecovery(context.plan, pending.id, pending.digest, "add")).toBe(
						"applied",
					);
					await context.reopen();
					expect(recoveryConflicts(context.plan)).toEqual([]);
					let source = room.project(context.plan.document);
					expect(source).toContain("The full saved human sentence.");
					expect(source).toContain("The full saved human sentence continues.");
					await submitClientUpdate(context.plan, second);
					expect(room.project(context.plan.document)).toBe(source);
					expect(recoveryConflicts(context.plan)).toEqual([]);
				} finally {
					peer.destroy();
				}
			});
		},
		30_000,
	);
} else {
	test.skip("PostgreSQL provenance restoration needs TEST_DATABASE_URL", () => {});
}
