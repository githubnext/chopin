import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

import { $createCalloutNode, $createCodeBlockNode, registry } from "@chopin/dialect";

import { $caretBlock, $duplicateBlock, $moveBlock } from "./block-keys";

const REGISTRY = registry();

function run(build: () => void, act: () => void): string[] {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
	editor.update(build, { discrete: true });
	editor.update(act, { discrete: true });
	return editor.getEditorState().read(() =>
		$getRoot().getChildren().map(node => `${node.getType()}:${node.getTextContent()}`)
	);
}

function paragraph(text: string) {
	return $createParagraphNode().append($createTextNode(text));
}

test("a block moves past its neighbour, and never above the title", () => {
	let build = () => {
		let second = paragraph("Second.");
		$getRoot().append(
			$createHeadingNode("h1").append($createTextNode("Title")),
			paragraph("First."),
			second,
		);
		second.selectEnd();
	};
	let moved = (direction: "up" | "down") => () => {
		let block = $caretBlock();
		if (block) $moveBlock(block, direction);
		if (block && direction === "up") $moveBlock(block, direction);
	};
	expect(run(build, moved("up"))).toEqual([
		"heading:Title",
		"paragraph:Second.",
		"paragraph:First.",
	]);
	expect(run(build, moved("down"))).toEqual([
		"heading:Title",
		"paragraph:First.",
		"paragraph:Second.",
	]);
});

test("the title is not a block that moves", () => {
	expect(run(() => {
		let title = $createHeadingNode("h1").append($createTextNode("Title"));
		$getRoot().append(title, paragraph("Body."));
		title.selectEnd();
	}, () => {
		expect($caretBlock()).toBeUndefined();
	})).toHaveLength(2);
});

test("a copy of text or code goes after it, and nothing with an identity is copied", () => {
	expect(run(() => {
		let code = $createCodeBlockNode("ts", "a();");
		$getRoot().append(paragraph("Before."), code);
		code.selectEnd();
	}, () => {
		$duplicateBlock($caretBlock()!);
	})).toEqual(["paragraph:Before.", "plan-code:a();", "plan-code:a();"]);

	expect(run(() => {
		let inside = paragraph("Inside.");
		$getRoot().append($createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA").append(inside));
		inside.selectEnd();
	}, () => {
		let block = $caretBlock()!;
		expect(block.getType()).toBe("paragraph");
		expect($duplicateBlock(block.getParent()!)).toBe(false);
		$duplicateBlock(block);
	})).toEqual(["plan-callout:Inside.\n\nInside."]);
});
