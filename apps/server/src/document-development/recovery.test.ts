import { afterEach, expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { reconcile } from "./reconcile";
import { recoveryConflicts, resolveRecovery } from "./recovery-actions";
import {
	clientEdit,
	clientPeer,
	fixture,
	request,
	submitClientUpdate,
} from "./provenance.test-fixtures";
import { MAX_RETIRED } from "./recovery-state";
import { restore } from "./state";

let contexts: Awaited<ReturnType<typeof fixture>>[] = [];
async function opened() {
	let context = await fixture();
	contexts.push(context);
	return context;
}
afterEach(async () => {
	for (let context of contexts) await Service.close(context.plan);
	contexts = [];
});

test("a crash after the generated commit retains original history for unacknowledged replay", async () => {
	let context = await opened();
	let { plan, storage } = context;
	let peer = await clientPeer(plan);
	let original = storage.collaboration.commit.bind(storage.collaboration);
	let commit = spyOn(storage.collaboration, "commit").mockImplementation(async input => {
		await original(input);
		throw new Error("crash before publication");
	});
	try {
		await expect(reconcile(plan, request(plan), () => true)).rejects.toThrow(
			"crash before publication",
		);
		commit.mockRestore();
		await Service.abortOpening(plan).catch(() => {});
		context.plan = await Service.open(plan.id, context.backend, context.server);
		let message = await peer.update({ index: 1, text: "Human words survive a server restart." });
		let acknowledgements: string[] = [];
		await submitClientUpdate(context.plan, message, true, acknowledgements);
		expect(acknowledgements.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(true);
		expect(room.project(context.plan.document)).toContain("Human words survive a server restart.");
		let source = room.project(context.plan.document);
		await submitClientUpdate(context.plan, message);
		expect(room.project(context.plan.document)).toBe(source);
		await Service.close(context.plan);
		context.plan = await Service.open(plan.id, context.backend, context.server);
		expect(room.project(context.plan.document)).toBe(source);
		expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("protected");
	} finally {
		commit.mockRestore();
		peer.destroy();
	}
});

test("continued old-identity edits remain explicit conflicts and exact-version resolution appends once", async () => {
	let context = await opened();
	let { plan } = context;
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		await submitClientUpdate(plan, await peer.update({ index: 1, text: "First human version." }));
		expect(recoveryConflicts(plan)).toEqual([]);
		await submitClientUpdate(plan, await peer.update({ index: 1, text: "Second human version." }));
		let [conflict] = recoveryConflicts(plan);
		expect(conflict!.source).toContain("Second human version.");
		expect(room.project(plan.document)).toContain("First human version.");
		expect(room.project(plan.document)).not.toContain("Second human version.");
		await clientEdit(plan, { index: 3, text: "Someone edits the recovered copy independently." });
		await submitClientUpdate(plan, await peer.update({ index: 1, text: "Third human version." }));
		expect(await resolveRecovery(plan, conflict!.id, conflict!.digest, "dismiss")).toBe("stale");
		await Service.close(plan);
		context.plan = await Service.open(plan.id, context.backend, context.server);
		let latest = recoveryConflicts(context.plan)[0]!;
		expect(latest.source).toContain("Third human version.");
		expect(await resolveRecovery(context.plan, latest.id, latest.digest, "add")).toBe("applied");
		expect(await resolveRecovery(context.plan, latest.id, latest.digest, "add")).toBe("stale");
		expect(room.project(context.plan.document)).toContain(
			"Someone edits the recovered copy independently.",
		);
		expect(room.project(context.plan.document)).toContain("Third human version.");
		expect(recoveryConflicts(context.plan)).toEqual([]);
	} finally {
		peer.destroy();
	}
});

test.each(["add", "dismiss"] as const)(
	"replay after %s and reopen cannot restore an earlier human version",
	async action => {
		let context = await opened();
		let peer = await clientPeer(context.plan);
		try {
			await reconcile(context.plan, request(context.plan), () => true);
			await submitClientUpdate(
				context.plan,
				await peer.update({ index: 1, text: "The full saved human sentence." }),
			);
			let second = await peer.update({
				index: 1,
				text: "The full saved human sentence continues.",
			});
			await submitClientUpdate(context.plan, second);
			let pending = recoveryConflicts(context.plan)[0]!;
			expect(await resolveRecovery(context.plan, pending.id, pending.digest, action)).toBe(
				"applied",
			);
			await Service.close(context.plan);
			context.plan = await Service.open(context.plan.id, context.backend, context.server);
			let source = room.project(context.plan.document);
			await submitClientUpdate(context.plan, second);
			expect(room.project(context.plan.document)).toBe(source);
			expect(recoveryConflicts(context.plan)).toEqual([]);
			await submitClientUpdate(
				context.plan,
				await peer.update({ index: 1, text: "The full saved human sentence continues again." }),
			);
			expect(recoveryConflicts(context.plan)[0]!.source).toContain(
				"The full saved human sentence continues again.",
			);
		} finally {
			peer.destroy();
		}
	},
);

test("same-epoch recovery capacity refuses another destructive generation without evicting history", async () => {
	let { plan } = await opened();
	await reconcile(plan, request(plan), () => true);
	let recovery = plan.documentDevelopment!.recovery!;
	let retired = recovery.retired[0]!;
	recovery.retired = Array.from(
		{ length: MAX_RETIRED },
		(_, i) => ({ ...retired, id: `retired-${i}` }),
	);
	let before = room.project(plan.document);
	let input = request(plan, {
		jobId: "job-2",
		messageId: "m3",
		changes: [{
			id: "passage-1",
			markdown: "Another replacement.",
			sourceIds: ["m2"],
		}],
	});
	expect((await reconcile(plan, input, () => true)).status).toBe("capacity");
	expect(room.project(plan.document)).toBe(before);
	expect(plan.documentDevelopment!.recovery!.retired).toHaveLength(MAX_RETIRED);
});

test("malformed durable recovery cannot silently lose retained human versions", async () => {
	let { plan } = await opened();
	await reconcile(plan, request(plan), () => true);
	let state = structuredClone(plan.documentDevelopment!);
	state.recovery!.document = "broken";
	expect(() => restore(state)).toThrow("recovery");
	state = structuredClone(plan.documentDevelopment!);
	state.recovery!.retired[0]!.version = {
		digest: room.digest("Other text."),
		source: "Saved human text.",
		status: "pending",
	};
	expect(() => restore(state)).toThrow("recovery");
});

test("close-only compaction retires raw history but preserves pending human text", async () => {
	let context = await opened();
	let { plan } = context;
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		await submitClientUpdate(plan, await peer.update({ index: 1, text: "Human copy." }));
		await submitClientUpdate(
			plan,
			await peer.update({ index: 1, text: "Pending human recovery." }),
		);
		let stale = await peer.update({ index: 1, text: "A later old-epoch update." });
		let recovery = plan.documentDevelopment!.recovery!;
		let shadow = new Y.Doc();
		Y.applyUpdate(shadow, Buffer.from(recovery.document, "base64"));
		shadow.getText("compaction-fixture").insert(0, "x".repeat(4 * 1024 * 1024));
		recovery.document = Buffer.from(Y.encodeStateAsUpdate(shadow)).toString("base64");
		shadow.destroy();
		let epoch = plan.document.epoch;
		await Service.close(plan);
		context.plan = await Service.open(plan.id, context.backend, context.server);
		expect(context.plan.document.epoch).not.toBe(epoch);
		expect(context.plan.documentDevelopment!.recovery!.epoch).toBe(context.plan.document.epoch);
		expect(recoveryConflicts(context.plan)[0]!.source).toContain("Pending human recovery.");
		let before = room.project(context.plan.document);
		await submitClientUpdate(context.plan, stale);
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.documentDevelopment!.recovery!.retired).toHaveLength(1);
	} finally {
		peer.destroy();
	}
});

test("ordinary server edits and cumulative human deletes cannot erase a retained human history", async () => {
	let { plan } = await opened();
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		await submitClientUpdate(
			plan,
			await peer.update({ index: 1, text: "The retained human sentence." }),
		);
		await Service.rewrite(
			plan,
			`${room.project(plan.document)}\nUnrelated server context.\n`,
			() => ({
				id: "rewrite-1",
				idempotencyKey: "rewrite-1",
				fingerprint: "test",
				fromRevision: plan.revision,
				client: { name: "test", version: "1" },
				document: {
					source: room.project(plan.document),
					revision: plan.revision,
					title: "Notes",
					url: "test",
				},
			}),
		);
		let current = await clientPeer(plan);
		try {
			await current.update({ index: 2, text: "A current human edit elsewhere." });
			await submitClientUpdate(plan, current.full());
		} finally {
			current.destroy();
		}
		await submitClientUpdate(
			plan,
			await peer.update({ index: 1, text: "The retained human sentence continues." }),
		);
		expect(recoveryConflicts(plan)[0]!.source).toContain("The retained human sentence continues.");
		expect(room.project(plan.document)).toContain("The retained human sentence.");
		expect(room.project(plan.document)).toContain("A current human edit elsewhere.");
	} finally {
		peer.destroy();
	}
});

test.each(["empty", "delete"])(
	"a late human %s latches protection without inventing prose",
	async change => {
		let { plan } = await opened();
		let peer = await clientPeer(plan);
		try {
			await reconcile(plan, request(plan), () => true);
			await submitClientUpdate(
				plan,
				await peer.update(
					change === "empty"
						? { index: 1, text: "" }
						: [{ op: "delete", index: 1 }],
				),
			);
			expect(plan.documentDevelopment!.passages[0]!.status).toBe("protected");
			expect(recoveryConflicts(plan)).toEqual([]);
		} finally {
			peer.destroy();
		}
	},
);

test("the full human list survives replacement by a different ordinary block shape", async () => {
	let context = await fixture(
		"# Notes\n\n- Original first item.\n- Original second item.\n\nHuman context.\n",
	);
	contexts.push(context);
	let { plan } = context;
	let peer = await clientPeer(plan);
	try {
		await reconcile(
			plan,
			request(plan, {
				changes: [{
					id: "passage-1",
					markdown: "## A new direction",
					sourceIds: ["m2"],
				}],
			}),
			() => true,
		);
		await submitClientUpdate(
			plan,
			await peer.update({ index: 1, text: "The full human first item." }),
		);
		let source = room.project(plan.document);
		expect(source).toContain("The full human first item.");
		expect(source).toContain("Original second item.");
		expect(plan.documentDevelopment!.passages[0]!.status).toBe("protected");
	} finally {
		peer.destroy();
	}
});
