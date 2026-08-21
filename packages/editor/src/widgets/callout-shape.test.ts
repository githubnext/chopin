import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isParagraphNode,
	COLLABORATION_TAG,
} from "lexical";
import { $createCalloutNode, $isCalloutNode, registry } from "@chopin/dialect";

import { registerCalloutNormalization } from "./callout-shape";

function headless() {
	let schema = registry();
	return createHeadlessEditor({
		nodes: schema.nodes,
		onError(error) {
			throw error;
		},
	});
}

describe("callout shape", () => {
	it("wraps legacy direct text without replacing it", () => {
		let editor = headless();
		let textKey = "";

		editor.update(() => {
			let callout = $createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA");
			let text = $createTextNode("Body text.");
			textKey = text.getKey();
			callout.append(text);
			$getRoot().append(callout);
		}, { discrete: true });

		let unregister = registerCalloutNormalization(editor);
		editor.getEditorState().read(() => {
			let callout = $getRoot().getFirstChild();
			expect($isCalloutNode(callout)).toBe(true);
			if (!$isCalloutNode(callout)) return;

			let paragraph = callout.getFirstChild();
			expect($isParagraphNode(paragraph)).toBe(true);
			if (!$isParagraphNode(paragraph)) return;
			expect(paragraph.getTextContent()).toBe("Body text.");
			expect(paragraph.getFirstChild()?.getKey()).toBe(textKey);
		});
		unregister();
	});

	it("leaves valid block children unchanged", () => {
		let editor = headless();
		let paragraphKey = "";

		editor.update(() => {
			let callout = $createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA");
			let paragraph = $createParagraphNode().append($createTextNode("Already valid."));
			paragraphKey = paragraph.getKey();
			callout.append(paragraph);
			$getRoot().append(callout);
		}, { discrete: true });

		let unregister = registerCalloutNormalization(editor);
		editor.getEditorState().read(() => {
			let callout = $getRoot().getFirstChild();
			expect($isCalloutNode(callout)).toBe(true);
			if (!$isCalloutNode(callout)) return;
			expect(callout.getFirstChild()?.getKey()).toBe(paragraphKey);
		});
		unregister();
	});

	it("repairs direct text arriving through collaboration", () => {
		let editor = headless();
		let unregister = registerCalloutNormalization(editor);

		editor.update(
			() => {
				let callout = $createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA");
				callout.append($createTextNode("Body text."));
				$getRoot().append(callout);
			},
			{ discrete: true, skipTransforms: true, tag: COLLABORATION_TAG },
		);

		editor.getEditorState().read(() => {
			let callout = $getRoot().getFirstChild();
			expect($isCalloutNode(callout)).toBe(true);
			if (!$isCalloutNode(callout)) return;
			expect($isParagraphNode(callout.getFirstChild())).toBe(true);
		});
		unregister();
	});
});
