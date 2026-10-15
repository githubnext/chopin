import { expect, test } from "bun:test";
import type { Server } from "bun";
import type { Config } from "../../config";
import type { Socket, SocketData } from "../../wire";
import type { Room } from "../../chat/service";
import * as Plan from "../../plan/service";
import { setParticipation } from "../../chat/initiative";
import { PostgresStorage } from "./adapter";

let database = process.env.TEST_DATABASE_URL;

if (database) {
	test(
		"PostgreSQL restores shared participation preference without replaying opportunities",
		async () => {
			let storage = new PostgresStorage(database);
			await storage.migrate();
			let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60_000);
			if (!lease) throw new Error("writer lease unavailable");
			let server = {
				publish() {
					return 0;
				},
			} as unknown as Server<SocketData>;
			let backend: Plan.Backend = {
				storage,
				lease: () => lease,
				fatal(error) {
					throw error;
				},
			};
			let plan: Plan.Plan | undefined;
			let id = crypto.randomUUID();
			try {
				let now = new Date();
				let user = crypto.randomUUID();
				await storage.users.put({ id: user, login: "initiative-test", avatarUrl: "", now });
				await storage.channels.create({
					id,
					repositoryId: crypto.randomUUID(),
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Participation",
					createdBy: user,
					now,
					initial: await Plan.initial("# Participation\n\nA shared document."),
				});
				plan = await Plan.open(id, backend, server);
				let change = async (paused: boolean) => {
					let opened = plan!;
					let context = {
						room: id,
						plan: opened,
						chat: opened.chat,
						server,
						config: { agent: true } as Config,
						persist: view => Plan.persist(opened, view),
					} as Room;
					await setParticipation(context, { send() {} } as unknown as Socket, {
						kind: "chat:participation",
						ts: 0,
						rid: crypto.randomUUID(),
						paused,
					});
				};
				plan.chat.entries.push({
					id: crypto.randomUUID(),
					author: { kind: "member", handle: "initiative-test" },
					text: "A saved contribution is never a restart trigger.",
					ts: Math.floor(Date.now() / 1000),
				});
				await change(true);
				let saved = await storage.collaboration.load(id, new Date());
				expect(saved?.sidecar ?? saved?.snapshot?.sidecar).toMatchObject({
					initiativePaused: true,
				});
				await Plan.close(plan);
				await storage.close();
				storage = new PostgresStorage(database);
				backend.storage = storage;
				plan = await Plan.open(id, backend, server);
				expect(plan.chat.initiativePaused).toBe(true);
				expect(plan.chat.initiative).toBeUndefined();
				expect(plan.chat.entries).toHaveLength(1);
				await change(false);
				await Plan.close(plan);
				plan = await Plan.open(id, backend, server);
				expect(plan.chat.initiativePaused).toBe(false);
				expect(plan.chat.initiative).toBeUndefined();
				expect(plan.chat.busy).toBe(false);
			} finally {
				if (plan) await Plan.close(plan);
				await storage.leases.release(lease);
				await storage.close();
			}
		},
		30_000,
	);
} else {
	test.skip("PostgreSQL participation restoration needs TEST_DATABASE_URL", () => {});
}
