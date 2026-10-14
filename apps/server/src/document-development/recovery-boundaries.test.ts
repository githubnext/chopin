import { afterEach, expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { reconcile } from "./reconcile";
import { recoveryConflicts, resolveRecovery } from "./recovery-actions";
import { canRetire } from "./recovery";
import { clientPeer, fixture, request, submitClientUpdate } from "./provenance.test-fixtures";

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

test("recovered text and its notification commit before the human acknowledgement", async () => {
	let { plan, storage } = await opened();
	let peer = await clientPeer(plan);
	await reconcile(plan, request(plan), () => true);
	let snapshots: unknown[] = [];
	plan.persistence.onDocumentDevelopmentPersisted = (_id, state) => snapshots.push(state);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let original = storage.collaboration.commit.bind(storage.collaboration);
	let commit = spyOn(storage.collaboration, "commit").mockImplementation(async input => {
		entered.resolve();
		await release.promise;
		return original(input);
	});
	try {
		let frames: string[] = [];
		let message = await peer.update({
			index: 1,
			text: "Human text waits for durable acknowledgement.",
		});
		let writing = submitClientUpdate(plan, message, true, frames);
		await entered.promise;
		expect(frames).toEqual([]);
		expect(snapshots).toEqual([]);
		expect(plan.documentDevelopment!.recovery!.retired[0]!.version).toBeUndefined();
		release.resolve();
		await writing;
		expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(true);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ passages: [{ status: "protected" }] });
		let loaded = await storage.collaboration.load(plan.id, new Date());
		expect(JSON.stringify(loaded!.sidecar)).toContain(
			"Human text waits for durable acknowledgement.",
		);
		await Service.persist(plan);
		expect(snapshots).toHaveLength(1);
	} finally {
		release.resolve();
		commit.mockRestore();
		peer.destroy();
	}
});

test("invalid structures hidden under a retired parent reject the batch before acknowledgement", async () => {
	let { plan, broadcasts } = await opened();
	let original = new Y.Doc();
	Y.applyUpdate(original, Y.encodeStateAsUpdate(plan.document.doc));
	let anchor = plan.documentDevelopment!.passages[0]!.anchor;
	await reconcile(plan, request(plan), () => true);
	let source = room.project(plan.document);
	let updates: Uint8Array[] = [];
	original.on("update", (update: Uint8Array) => updates.push(update));
	let position = Y.decodeRelativePosition(Buffer.from(anchor.position, "base64"));
	let paragraph = Y.createAbsolutePositionFromRelativePosition(position, original)!
		.type as Y.XmlText;
	let unknown = new Y.XmlText();
	unknown.setAttribute("__type", "invalid-recovery-node");
	paragraph.insertEmbed(0, unknown);
	let frames: string[] = [];
	let logging = spyOn(console, "error").mockImplementation(() => {});
	try {
		await submitClientUpdate(
			plan,
			{
				epoch: plan.document.epoch,
				id: "invalid-retired-update",
				update: Buffer.from(Y.mergeUpdates(updates)).toString("base64"),
			},
			true,
			frames,
		);
		expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(false);
		expect(broadcasts.some(frame => frame.kind === "plan:reset")).toBe(true);
		expect(room.project(plan.document)).toBe(source);
		expect(recoveryConflicts(plan)).toEqual([]);
	} finally {
		logging.mockRestore();
		original.destroy();
	}
});

test("an oversized hidden human passage is rejected instead of acknowledged without recovery", async () => {
	let { plan, broadcasts } = await opened();
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		let frames: string[] = [];
		let message = await peer.update({ index: 1, text: "x".repeat(270 * 1024) });
		await submitClientUpdate(plan, message, true, frames);
		expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(false);
		expect(broadcasts.some(frame => frame.kind === "plan:reset")).toBe(true);
		expect(recoveryConflicts(plan)).toEqual([]);
	} finally {
		peer.destroy();
	}
});

test("recovery resolution rechecks lifecycle eligibility after staging", async () => {
	let { plan } = await opened();
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		await submitClientUpdate(plan, await peer.update({ index: 1, text: "First human version." }));
		await submitClientUpdate(plan, await peer.update({ index: 1, text: "Pending human version." }));
		let conflict = recoveryConflicts(plan)[0]!;
		let source = room.project(plan.document);
		let checks = 0;
		expect(await resolveRecovery(plan, conflict.id, conflict.digest, "add", () => ++checks === 1))
			.toBe("blocked");
		expect(checks).toBe(2);
		expect(room.project(plan.document)).toBe(source);
		expect(recoveryConflicts(plan)).toEqual([conflict]);
	} finally {
		peer.destroy();
	}
});

test("closing an archived document retains its oversized replay history without replacing the epoch", async () => {
	let context = await opened();
	let { plan, storage } = context;
	await reconcile(plan, request(plan), () => true);
	let recovery = plan.documentDevelopment!.recovery!;
	let shadow = new Y.Doc();
	Y.applyUpdate(shadow, Buffer.from(recovery.document, "base64"));
	shadow.getText("archived-compaction-fixture").insert(0, "x".repeat(4 * 1024 * 1024));
	recovery.document = Buffer.from(Y.encodeStateAsUpdate(shadow)).toString("base64");
	shadow.destroy();
	await Service.persist(plan);
	await storage.channels.archive({ id: plan.id, now: new Date() });
	let epoch = plan.document.epoch;
	let replace = spyOn(storage.collaboration, "replace");
	try {
		await Service.close(plan);
		expect(replace).not.toHaveBeenCalled();
		context.plan = await Service.open(plan.id, context.backend, context.server);
		expect(context.plan.document.epoch).toBe(epoch);
		expect(context.plan.documentDevelopment!.recovery!.retired).toHaveLength(1);
	} finally {
		replace.mockRestore();
	}
});

test("retirement capacity includes history before the first automatic replacement", async () => {
	let { plan } = await opened();
	expect(canRetire(plan)).toBe(true);
	plan.document.doc.getText("initial-history-fixture").insert(0, "x".repeat(1024 * 1024));
	expect(canRetire(plan)).toBe(false);
	let source = room.project(plan.document);
	expect((await reconcile(plan, request(plan), () => true)).status).toBe("capacity");
	expect(room.project(plan.document)).toBe(source);
});
