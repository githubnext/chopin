import { expect, spyOn, test } from "bun:test";

import { $createParagraphNode, $getRoot, $isParagraphNode } from "lexical";
import * as Y from "yjs";
import * as Questions from "./service";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { Socket } from "../wire";
import { createConversationCardFixture } from "./conversation-card.test-fixtures";
import type { Plan } from "../plan/service";

let plans: Plan[];
let fixture = createConversationCardFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION, input } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("Reopen follows moved decision prose in one commit and rolls back on storage failure", async () => {
	let context = await openPlan("# Title\n\nDecision prose.\n\nOther.\n");
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "Auth0" }]),
	);
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	await Questions.suggest(context.plan, context.server, "test", id, {
		optionId: OPTION,
		messageIds: ["m1"],
	});
	await Questions.submit(context.plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	});
	expect(context.plan.records.get(id)?.status).toBe("answered");
	let anchor = room.anchorAt(context.plan.document, 1, room.digests(context.plan.document)[1]!);
	context.plan.records.set(id, { ...context.plan.records.get(id)!, prose: [anchor] });
	await Service.persist(context.plan);
	let vector = Y.encodeStateVector(context.plan.document.doc);
	context.plan.document.editor.update(() => {
		let blocks = $getRoot().getChildren();
		blocks[3]!.insertAfter(blocks[1]!);
		blocks[1]!.insertBefore($createParagraphNode());
	}, { discrete: true });
	await room.settle();
	Questions.rebase(context.plan);
	anchor = context.plan.records.get(id)!.prose![0]!;
	await Service.exclusive(context.plan, () =>
		Service.publish(
			context.plan,
			context.server,
			"test",
			{
				update: Y.encodeStateAsUpdate(context.plan.document.doc, vector),
				source: room.project(context.plan.document),
			},
		));
	let proseAt = room.digests(context.plan.document).findIndex((_, index) =>
		room.matchesAnchor(context.plan.document, anchor, index)
	);
	expect(proseAt).toBeGreaterThan(room.questionnaireIndex(context.plan.document, id)!);
	let proseKey = room.resolveAnchor(context.plan.document, anchor);
	let proseType = context.plan.document.binding.collabNodeMap.get(proseKey!)?.getSharedType();
	let proseCaret = Y.createRelativePositionFromTypeIndex(proseType!, 0, -1);
	let emptyKey: string | undefined;
	context.plan.document.editor.getEditorState().read(() => {
		emptyKey = $getRoot().getChildren().find(node =>
			$isParagraphNode(node) && node.getChildrenSize() === 0
		)?.getKey();
	});
	if (!emptyKey) throw new Error("missing live empty caret paragraph");
	let emptyType = context.plan.document.binding.collabNodeMap.get(emptyKey)?.getSharedType();
	let emptyCaret = Y.createRelativePositionFromTypeIndex(emptyType!, 0, -1);
	let beforeSource = room.project(context.plan.document);
	let peer = await room.restore(
		context.plan.document.epoch,
		Y.encodeStateAsUpdate(context.plan.document.doc),
		beforeSource,
		[],
	);
	let beforeRecord = structuredClone(context.plan.records.get(id));
	let beforeFrames = context.broadcasts.length;
	let original = context.storage.collaboration.commit;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		await Questions.reopen(context.plan, context.server, "test", ws, {
			kind: "question:reopen",
			ts: 0,
			rid: "failed-reopen",
			id,
		});
	} finally {
		errors.mockRestore();
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(room.project(context.plan.document)).toBe(beforeSource);
	expect(context.plan.records.get(id)).toEqual(beforeRecord);
	expect(Y.createAbsolutePositionFromRelativePosition(emptyCaret, context.plan.document.doc, false))
		.not.toBeNull();
	expect(context.broadcasts.slice(beforeFrames).filter(frame => frame.kind === "plan:update"))
		.toHaveLength(0);
	await Questions.reopen(context.plan, context.server, "test", ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id,
	});
	expect(replies.at(-1)).toMatchObject({ kind: "question:reopen", ok: true });
	let movedAnchor = context.plan.records.get(id)!.prose![0]!;
	let afterProseAt = room.digests(context.plan.document).findIndex((_, index) =>
		room.matchesAnchor(context.plan.document, movedAnchor, index)
	);
	expect(afterProseAt).toBeGreaterThanOrEqual(0);
	expect(room.questionnaireIndex(context.plan.document, id)).toBe(afterProseAt + 1);
	expect(room.resolveAnchor(context.plan.document, context.plan.records.get(id)!.prose![0]!))
		.toBe(proseKey);
	expect(Y.createAbsolutePositionFromRelativePosition(proseCaret, context.plan.document.doc, false))
		.not.toBeNull();
	context.plan.document.editor.getEditorState().read(() => {
		expect($getRoot().getChildren().some(node => node.getKey() === emptyKey)).toBe(true);
	});
	expect(Y.createAbsolutePositionFromRelativePosition(emptyCaret, context.plan.document.doc, false))
		.not.toBeNull();
	expect(context.plan.records.get(id)).toMatchObject({
		status: "reopened",
		history: [{ choices: [OPTION], owner: "ana" }],
	});
	expect(room.project(context.plan.document)).toContain("<Previous");
	let updates = context.broadcasts.slice(beforeFrames).filter(frame =>
		frame.kind === "plan:update"
	);
	expect(updates).toHaveLength(1);
	let update = updates[0]?.update;
	if (typeof update !== "string") throw new Error("missing persisted Reopen delta");
	Y.applyUpdate(peer.doc, Buffer.from(update, "base64"), "remote");
	await room.settle();
	expect(Y.createAbsolutePositionFromRelativePosition(proseCaret, peer.doc, false))
		.not.toBeNull();
	let peerCaret = Y.createAbsolutePositionFromRelativePosition(emptyCaret, peer.doc, false);
	expect(peerCaret).not.toBeNull();
	peer.editor.getEditorState().read(() => {
		expect(
			$getRoot().getChildren().some(node =>
				$isParagraphNode(node) && node.getChildrenSize() === 0
				&& peer.binding.collabNodeMap.get(node.getKey())?.getSharedType() === peerCaret?.type
			),
		).toBe(true);
	});
	expect(room.project(peer)).toBe(room.project(context.plan.document));
	peer.doc.destroy();
});
