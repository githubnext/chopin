import { expect, test } from "bun:test";
import { applyAnchors, applyBlockEdit } from "../agent/document-ops";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { fixture, restart, running, scopeRoom } from "./decision-followup.test-fixtures";
import { scopeSnapshot } from "./decision-followup";
import { writeScope } from "./decision-followup-write";

let source =
	"Offline support is required even when the network is unavailable.\n\n| Mode    | Available |\n| ------- | --------- |\n| Offline | Yes       |\n\nThe existing API stays stable.";

async function rewritten(count = 1, applied = true) {
	let context = await fixture(count);
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support.");
	let room = scopeRoom(context);
	room.publish = mutation =>
		Service.publish(context.plan, context.server, context.plan.id, mutation);
	room.persist = () => Service.persist(context.plan);
	if (applied) {
		let snapshot = scopeSnapshot(context.plan, id);
		await writeScope(room, running(context), context.plan.chat.turn, {
			id,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "Offline support is required.",
		});
	}
	await room.exclusive(() =>
		applyBlockEdit(room, {
			revision: context.plan.revision,
			operations: [{ op: "replace", index: 0, source }],
		})
	);
	let digests = Room.digests(context.plan.document);
	let anchors = context.ids.map(widget => ({
		widget,
		question: context.plan.records.get(widget)!.definition.questions[0]!.id,
		blocks: [0, 1, 2].map(index => ({ index, digest: digests[index]! })),
	}));
	return { context, room, id, anchors };
}

test("an explicit reviewed re-anchor restores the full rewritten passage and existing prose durably", async () => {
	let { context, room, id, anchors } = await rewritten();
	expect(context.plan.records.get(id)!.prose![0]!.orphaned).toBe(true);
	expect(await applyAnchors(room, { revision: context.plan.revision, anchors }))
		.toMatchObject({ ok: true });
	let restored = await restart(context);
	expect(scopeSnapshot(restored.plan, id).source).toBe(`${source}\n`);
	expect(restored.plan.records.get(id)!.prose).toHaveLength(3);
	expect(restored.plan.records.get(id)!.prose!.every(anchor => !anchor.orphaned)).toBe(true);
	expect(restored.plan.records.get(id)!.followUp!.appliedGeneration).toBe(1);
	expect(Room.project(restored.plan.document)).toContain("Keep this unrelated paragraph.");
});

test("re-anchoring an unwritten decision repairs its target without claiming an applied write", async () => {
	let { context, room, id, anchors } = await rewritten(1, false);
	await applyAnchors(room, { revision: context.plan.revision, anchors });
	expect(context.plan.records.get(id)!.prose).toBeUndefined();
	expect(context.plan.records.get(id)!.followUp!.appliedGeneration).toBeUndefined();
	let snapshot = scopeSnapshot(context.plan, id);
	await writeScope(room, running(context), context.plan.chat.turn, {
		id,
		revision: snapshot.revision,
		answersHash: snapshot.answersHash,
		source: `${source}\n\nThe saved choice is kept across later edits.`,
	});
	let restored = await restart(context);
	expect(scopeSnapshot(restored.plan, id).source).toContain(
		"The saved choice is kept across later edits.",
	);
	expect(restored.plan.records.get(id)!.followUp!.appliedGeneration).toBe(1);
});

test("complete peer placements preserve both saved answers through the next multi-paragraph write", async () => {
	let { context, room, id, anchors } = await rewritten(2);
	let second = context.ids[1]!;
	await context.save(second, "Preserve the existing API.");
	expect(await applyAnchors(room, { revision: context.plan.revision, anchors }))
		.toMatchObject({ ok: true });
	let snapshot = scopeSnapshot(context.plan, second);
	expect(snapshot.source).toBe(`${source}\n`);
	expect(JSON.stringify(snapshot.decisions)).toContain("Keep offline support.");
	expect(JSON.stringify(snapshot.decisions)).toContain("Preserve the existing API.");
	await writeScope(room, running(context, second), context.plan.chat.turn, {
		id: second,
		revision: snapshot.revision,
		answersHash: snapshot.answersHash,
		source,
	});
	let restored = await restart(context);
	expect(scopeSnapshot(restored.plan, id).source).toBe(`${source}\n`);
	expect(restored.plan.records.get(id)!.followUp!.appliedGeneration).toBe(1);
	expect(restored.plan.records.get(second)!.followUp!.appliedGeneration).toBe(1);
	expect(restored.plan.records.get(id)!.answers).toEqual(
		snapshot.decisions.find(peer => peer.id === id)!.answers!,
	);
	expect(Room.project(restored.plan.document)).toContain("Keep this unrelated paragraph.");
});

test.each(["digest", "question"])(
	"an invalid re-anchor %s changes no links or targets",
	async kind => {
		let { context, room, id, anchors } = await rewritten();
		let before = structuredClone(context.plan.records.get(id));
		if (kind === "digest") anchors[0]!.blocks[0]!.digest = `sha256:${"0".repeat(64)}`;
		else anchors[0]!.question = "unknown-question";
		expect(await applyAnchors(room, { revision: context.plan.revision, anchors }))
			.toMatchObject({ ok: false, reason: "invalid" });
		expect(context.plan.records.get(id)).toEqual(before);
	},
);

test("reviewed prose keeps its existing adjacent native visual even when only prose is named", async () => {
	let { context, room, id, anchors } = await rewritten();
	anchors[0]!.blocks = anchors[0]!.blocks.filter(block => block.index !== 1);
	expect(await applyAnchors(room, { revision: context.plan.revision, anchors }))
		.toMatchObject({ ok: true });
	expect(scopeSnapshot(context.plan, id).source).toBe(`${source}\n`);
	expect(context.plan.records.get(id)!.followUp!.target).toHaveLength(3);
});

test.each(["missing-peer", "disagreeing-peer", "unrelated-gap"])(
	"re-anchoring refuses %s rather than inferring a scope",
	async kind => {
		let { context, room, id, anchors } = await rewritten(2);
		let before = structuredClone(context.plan.records.get(id)!.followUp);
		if (kind === "missing-peer") anchors.pop();
		if (kind === "disagreeing-peer") anchors[1]!.blocks = anchors[1]!.blocks.slice(0, 1);
		if (kind === "unrelated-gap") {
			let digests = Room.digests(context.plan.document);
			for (let update of anchors) {
				update.blocks = [0, 3].map(index => ({ index, digest: digests[index]! }));
			}
		}
		expect(await applyAnchors(room, { revision: context.plan.revision, anchors }))
			.toMatchObject({ ok: false });
		expect(context.plan.records.get(id)!.followUp).toEqual(before);
	},
);

test("a rejected re-anchor commit preserves the live and durable target and prose", async () => {
	let { context, room, id, anchors } = await rewritten();
	let before = structuredClone(context.plan.records.get(id));
	let sourceBefore = Room.project(context.plan.document);
	let broadcasts = context.broadcasts.length;
	let commit = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new Error("re-anchor commit failed");
	};
	try {
		await expect(applyAnchors(room, { revision: context.plan.revision, anchors }))
			.rejects.toThrow("re-anchor commit failed");
	} finally {
		context.storage.collaboration.commit = commit;
	}
	expect(context.plan.records.get(id)).toEqual(before);
	expect(Room.project(context.plan.document)).toBe(sourceBefore);
	expect(context.broadcasts).toHaveLength(broadcasts);
	let restored = await restart(context);
	expect(restored.plan.records.get(id)!.followUp).toEqual(before!.followUp);
	expect(restored.plan.records.get(id)!.prose).toEqual(before!.prose);
});
