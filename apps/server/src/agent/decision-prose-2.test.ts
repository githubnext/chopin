import { expect, test } from "bun:test";
import { $createParagraphNode, $getRoot, $isParagraphNode } from "lexical";
import * as Y from "yjs";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { createDecisionProseFixture } from "./decision-prose.test-fixtures";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, WIDGET, OTHER_WIDGET, opened, job, proseTool, input } = fixture;

test("write_decision_prose addresses a first card past live leading and inter-card carets", async () => {
	let context = await opened(`${WIDGET}\n${OTHER_WIDGET}`);
	context.plan.document.editor.update(() => {
		let children = $getRoot().getChildren();
		children[0]!.insertBefore($createParagraphNode());
		children[1]!.insertBefore($createParagraphNode());
	}, { discrete: true });
	await room.settle();
	let caretKeys: string[] = [];
	context.plan.document.editor.getEditorState().read(() => {
		caretKeys = $getRoot().getChildren()
			.filter(node => $isParagraphNode(node) && node.getChildrenSize() === 0)
			.map(node => node.getKey());
	});
	expect(caretKeys).toHaveLength(2);
	let relatives = caretKeys.map(key => {
		let type = context.plan.document.binding.collabNodeMap.get(key)?.getSharedType();
		if (!type) throw new Error("caret has no shared identity");
		return Y.createRelativePositionFromTypeIndex(type, 0, -1);
	});
	let peer = await room.restore(
		context.plan.document.epoch,
		Y.encodeStateAsUpdate(context.plan.document.doc),
		room.project(context.plan.document),
		[],
	);
	expect(room.digests(context.plan.document)).toHaveLength(2);
	expect(room.questionnaireIndex(context.plan.document, CARD)).toBe(0);
	job(context);
	let response = await proseTool(context).handler(input(context), {} as never);
	expect(JSON.parse(String(response)).ok).toBe(true);
	expect(room.project(context.plan.document)).toStartWith(
		"We chose GitHub Apps.\n\n<Questionnaire",
	);
	expect(room.questionnaireIndex(context.plan.document, CARD)).toBe(1);
	expect(room.matchesAnchor(context.plan.document, context.plan.records.get(CARD)!.prose![0]!, 0))
		.toBe(true);
	context.plan.document.editor.getEditorState().read(() => {
		let current = new Set($getRoot().getChildren().map(node => node.getKey()));
		for (let key of caretKeys) expect(current.has(key)).toBe(true);
	});
	let update = context.broadcasts.find(frame => frame.kind === "plan:update")?.update;
	if (typeof update !== "string") throw new Error("missing persisted document delta");
	Y.applyUpdate(peer.doc, Buffer.from(update, "base64"), "remote");
	await room.settle();
	let absolutes = relatives.map(relative =>
		Y.createAbsolutePositionFromRelativePosition(relative, peer.doc, false)
	);
	for (let absolute of absolutes) expect(absolute).not.toBeNull();
	peer.editor.getEditorState().read(() => {
		let empty = $getRoot().getChildren().filter(node =>
			$isParagraphNode(node) && node.getChildrenSize() === 0
		);
		expect(empty).toHaveLength(2);
		for (let absolute of absolutes) {
			expect(
				empty.some(node =>
					peer.binding.collabNodeMap.get(node.getKey())?.getSharedType() === absolute?.type
				),
			).toBe(true);
		}
	});
	peer.doc.destroy();
	let expected = room.project(context.plan.document);
	await Service.close(context.plan);
	contexts = contexts.filter(item => item !== context);
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	contexts.push({ ...context, plan: reopened });
	expect(room.project(reopened.document)).toBe(expected);
	expect(room.matchesAnchor(reopened.document, reopened.records.get(CARD)!.prose![0]!, 0))
		.toBe(true);
});

test("write_decision_prose replaces the anchored duplicate, leaving its twin alone", async () => {
	let context = await opened(`Same.\n\nSame.\n\n${WIDGET}`);
	context.plan.records.get(CARD)!.prose = [
		room.anchorAt(context.plan.document, 1, room.digests(context.plan.document)[1]!),
	];
	job(context);
	let result = await proseTool(context).handler(input(context, "New prose."), {} as never);
	expect(JSON.parse(String(result)).mode).toBe("replace");
	expect(room.project(context.plan.document)).toStartWith("Same.\n\nNew prose.\n\n");
	expect(context.plan.records.get(CARD)!.prose).toHaveLength(1);
});
