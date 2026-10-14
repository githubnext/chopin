import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { reconcile } from "./reconcile";
import { canRetire } from "./recovery";
import { hasPendingCausalHistory } from "./recovery-yjs";
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

test("an incomplete dependent human update is rejected before acknowledgement", async () => {
	let context = await opened();
	let { plan, broadcasts } = context;
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		await peer.update({ index: 1, text: "A dependent human sentence" });
		let second = await peer.update({
			index: 1,
			text: "A dependent human sentence survives in full.",
		});
		let source = room.project(plan.document);
		let epoch = plan.document.epoch;
		let frames: string[] = [];
		await submitClientUpdate(plan, second, true, frames);
		expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(false);
		expect(broadcasts.some(frame => frame.kind === "plan:reset")).toBe(true);
		expect(plan.document.epoch).not.toBe(epoch);
		expect(room.project(plan.document)).toBe(source);
		await Service.close(plan);
		context.plan = await Service.open(plan.id, context.backend, context.server);
		expect(room.project(context.plan.document)).toBe(source);
		expect(hasPendingCausalHistory(context.plan.document.doc)).toBe(false);
	} finally {
		peer.destroy();
	}
});

test("a complete human batch accepts reversed causal order and retains every word after restart", async () => {
	let context = await opened();
	let { plan } = context;
	let peer = await clientPeer(plan);
	try {
		await reconcile(plan, request(plan), () => true);
		let first = await peer.update({ index: 1, text: "A dependent human sentence" });
		let second = await peer.update({
			index: 1,
			text: "A dependent human sentence survives in full.",
		});
		let frames: string[] = [];
		await submitClientUpdate(plan, second, false, frames);
		await submitClientUpdate(plan, first, false, frames);
		await Service.drain(plan);
		expect(frames.filter(frame => JSON.parse(frame).kind === "plan:ack")).toHaveLength(2);
		expect(room.project(plan.document)).toContain("A dependent human sentence survives in full.");
		await Service.close(plan);
		context.plan = await Service.open(plan.id, context.backend, context.server);
		expect(room.project(context.plan.document)).toContain(
			"A dependent human sentence survives in full.",
		);
	} finally {
		peer.destroy();
	}
});

test("retirement refuses existing accepted causal history until its missing update arrives", async () => {
	let { plan } = await opened();
	let peer = await clientPeer(plan);
	try {
		let first = await peer.update({ index: 1, text: "A dependent human sentence" });
		let second = await peer.update({
			index: 1,
			text: "A dependent human sentence survives in full.",
		});
		let frames: string[] = [];
		await submitClientUpdate(plan, second, true, frames);
		expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(true);
		expect(hasPendingCausalHistory(plan.document.doc)).toBe(true);
		expect(canRetire(plan)).toBe(false);
		expect((await reconcile(plan, request(plan), () => true)).status).toBe("capacity");
		expect(plan.documentDevelopment!.recovery).toBeUndefined();
		await submitClientUpdate(plan, first);
		expect(hasPendingCausalHistory(plan.document.doc)).toBe(false);
		expect(room.project(plan.document)).toContain("A dependent human sentence survives in full.");
	} finally {
		peer.destroy();
	}
});

test("an unresolved deletion without pending structs is rejected before acknowledgement", async () => {
	let { plan, broadcasts } = await opened();
	await reconcile(plan, request(plan), () => true);
	let peer = new Y.Doc();
	peer.getText("future-delete").insert(0, "unseen text");
	let deletion: Uint8Array | undefined;
	peer.on("update", (update: Uint8Array) => deletion = update);
	peer.getText("future-delete").delete(0, 11);
	expect(Y.decodeUpdate(deletion!).structs).toHaveLength(0);
	let frames: string[] = [];
	try {
		await submitClientUpdate(
			plan,
			{
				epoch: plan.document.epoch,
				id: "future-delete",
				update: Buffer.from(deletion!).toString("base64"),
			},
			true,
			frames,
		);
		expect(frames.some(frame => JSON.parse(frame).kind === "plan:ack")).toBe(false);
		expect(broadcasts.some(frame => frame.kind === "plan:reset")).toBe(true);
		expect(hasPendingCausalHistory(plan.document.doc)).toBe(false);
	} finally {
		peer.destroy();
	}
});
