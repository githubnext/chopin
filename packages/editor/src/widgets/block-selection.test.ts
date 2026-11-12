import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode } from "@lexical/list";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

import {
	$createCalloutNode,
	$createImageNode,
	$createResearchNode,
	registry,
} from "@chopin/dialect";

import { $dropBlocks } from "./block-handle";
import { $unformat } from "./block-keys";
import {
	$blocks,
	$clipboard,
	$duplicateBlocks,
	$moveBlocks,
	$range,
	$removeBlocks,
} from "./block-selection";

import type { LexicalEditor, LexicalNode } from "lexical";

const REGISTRY = registry();

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "plan",
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
}

function run(
	build: (editor: LexicalEditor) => void,
	act: (editor: LexicalEditor) => void,
): string[] {
	let target = editor();
	target.update(() => build(target), { discrete: true });
	target.update(() => act(target), { discrete: true });
	return target.getEditorState().read(() =>
		$getRoot().getChildren().map(node => `${node.getType()}:${node.getTextContent()}`)
	);
}

function paragraph(text: string) {
	return $createParagraphNode().append($createTextNode(text));
}

function item(text: string) {
	return $createListItemNode().append($createTextNode(text));
}

function title() {
	return $createHeadingNode("h1").append($createTextNode("Title"));
}

/** The blocks with these texts, in document order. */
function $named(...texts: string[]): LexicalNode[] {
	return $blocks().filter(block => texts.includes(block.getTextContent()));
}

test("blocks are walked in document order, a callout before its own, never the title", () => {
	run(() => {
		$getRoot().append(
			title(),
			paragraph("One."),
			$createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA").append(paragraph("Inside.")),
			$createListNode("bullet").append(item("A"), item("B")),
		);
	}, () => {
		expect($blocks().map(block => `${block.getType()}:${block.getTextContent()}`)).toEqual([
			"paragraph:One.",
			"plan-callout:Inside.",
			"paragraph:Inside.",
			"listitem:A",
			"listitem:B",
		]);
		let [one, , inside] = $blocks();
		// A range that covers a callout leaves out the blocks inside it.
		expect($range(one!, inside!).map(block => block.getType())).toEqual([
			"paragraph",
			"plan-callout",
		]);
	});
});

test("selected blocks copy as Markdown, and nothing with an identity is copied", () => {
	run(() => {
		$getRoot().append(
			title(),
			$createHeadingNode("h2").append($createTextNode("Plan")),
			$createListNode("bullet").append(item("First"), item("Second")),
			$createParagraphNode().append($createImageNode("https://example.com/a.png", "A")),
			$createResearchNode("01K0N4W3B7P27CBAEC7A8C8WEB"),
		);
	}, target => {
		let payload = $clipboard(target, $blocks());
		expect(payload?.markdown).toBe("## Plan\n\n- First\n- Second");
		expect(payload?.copied.map(block => block.getType())).toEqual([
			"heading",
			"listitem",
			"listitem",
		]);
		let lexical = JSON.parse(payload!.lexical) as { namespace: string; nodes: { type: string }[] };
		expect(lexical.namespace).toBe("plan");
		expect(lexical.nodes.map(node => node.type)).toEqual(["heading", "list"]);
	});
});

test("Delete removes selected blocks but never a record's card, and leaves the caret", () => {
	expect(run(() => {
		$getRoot().append(
			title(),
			paragraph("Keep."),
			paragraph("Gone."),
			$createResearchNode("01K0N4W3B7P27CBAEC7A8C8WEB"),
			paragraph("Also gone."),
		);
	}, () => {
		expect($removeBlocks($blocks().slice(1))).toBe(true);
	})).toEqual(["heading:Title", "paragraph:Keep.", "plan-research:"]);

	expect(run(() => {
		$getRoot().append(title(), paragraph("Only."));
	}, () => {
		$removeBlocks($blocks());
	})).toEqual(["heading:Title", "paragraph:"]);
});

test("duplicates go after their run, and blocks move past their neighbour but not the title", () => {
	expect(run(() => {
		$getRoot().append(title(), paragraph("One."), paragraph("Two."), paragraph("Three."));
	}, () => {
		let copies = $duplicateBlocks($named("One.", "Two."));
		expect(copies).toHaveLength(2);
	})).toEqual([
		"heading:Title",
		"paragraph:One.",
		"paragraph:Two.",
		"paragraph:One.",
		"paragraph:Two.",
		"paragraph:Three.",
	]);

	expect(run(() => {
		$getRoot().append(title(), paragraph("One."), paragraph("Two."), paragraph("Three."));
	}, () => {
		expect($moveBlocks($named("Two.", "Three."), "up")).toBe(true);
		expect($moveBlocks($named("Two.", "Three."), "up")).toBe(false);
	})).toEqual(["heading:Title", "paragraph:Two.", "paragraph:Three.", "paragraph:One."]);
});

test("a drop keeps each block at a level it may hold", () => {
	// List items dropped among paragraphs become a list of their own kind.
	expect(run(() => {
		$getRoot().append(
			title(),
			paragraph("Before."),
			$createListNode("number").append(item("A"), item("B")),
		);
	}, () => {
		let [before] = $named("Before.");
		expect($dropBlocks($named("B"), before!, "before")).toBe(true);
	})).toEqual(["heading:Title", "list:B", "paragraph:Before.", "list:A"]);

	// A paragraph dropped among list items goes beside the list; a callout stays at the top level.
	expect(run(() => {
		$getRoot().append(
			title(),
			$createListNode("bullet").append(item("A"), item("B")),
			paragraph("Moved."),
			$createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA").append(paragraph("Inside.")),
		);
	}, () => {
		let [a] = $named("A");
		expect($dropBlocks($named("Moved."), a!, "after")).toBe(true);
		let callout = $blocks().find(block => block.getType() === "plan-callout")!;
		expect($dropBlocks([callout], $named("A")[0]!, "before")).toBe(true);
	})).toEqual([
		"heading:Title",
		"plan-callout:Inside.",
		"list:A\n\nB",
		"paragraph:Moved.",
	]);
});

test("Backspace at the start of a heading or a list item makes it text, splitting the list", () => {
	expect(run(() => {
		let heading = $createHeadingNode("h2").append($createTextNode("Section"));
		$getRoot().append(title(), heading);
		heading.selectStart();
	}, target => {
		expect($unformat(target)).toBe(true);
	})).toEqual(["heading:Title", "paragraph:Section"]);

	expect(run(() => {
		let middle = item("B");
		$getRoot().append(title(), $createListNode("bullet").append(item("A"), middle, item("C")));
		middle.selectStart();
	}, target => {
		expect($unformat(target)).toBe(true);
	})).toEqual(["heading:Title", "list:A", "paragraph:B", "list:C"]);

	// The title stays the title.
	expect(run(() => {
		let heading = title();
		$getRoot().append(heading, paragraph("Body."));
		heading.selectStart();
	}, target => {
		expect($unformat(target)).toBe(false);
	})).toEqual(["heading:Title", "paragraph:Body."]);
});
