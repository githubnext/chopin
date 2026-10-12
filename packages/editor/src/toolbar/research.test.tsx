import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from "@lexical/list";
import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
import { $createResearchNode, ResearchNode } from "@chopin/dialect";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$insertNodes,
	$isTextNode,
} from "lexical";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { $draftAttachment } from "./research";

import type { ElementNode, LexicalNode } from "lexical";

import type { ComponentType, PropsWithChildren } from "react";

type DraftLayerModule = {
	ResearchDraftShell?: ComponentType<PropsWithChildren>;
	retainDraftBlock?: <Block>(resolved: Block | undefined, previous: Block | undefined) =>
		| Block
		| undefined;
};

async function draftLayer(): Promise<DraftLayerModule> {
	return await import("./research").catch(() => ({}));
}

async function draftShell(): Promise<ComponentType<PropsWithChildren> | undefined> {
	let Shell = (await draftLayer()).ResearchDraftShell;
	expect(typeof Shell).toBe("function");
	return Shell;
}

describe("research draft layer", () => {
	it("renders the private draft as labelled inline editor chrome", async () => {
		let Shell = await draftShell();
		if (!Shell) return;
		let markup = renderToStaticMarkup(
			createElement(Shell, null, createElement("span", null, "Draft question")),
		);

		expect(markup).toContain('role="region"');
		expect(markup).toContain('aria-label="Research question"');
		expect(markup).not.toContain('role="dialog"');
		expect(markup).toContain("plan-research-draft");
		expect(markup).toContain("Draft question");
	});

	it("keeps the last block attachment while the saved position is unresolved", async () => {
		let retain = (await draftLayer()).retainDraftBlock;
		expect(typeof retain).toBe("function");
		if (!retain) return;
		let previous = { key: "previous" };

		expect(retain(undefined, previous)).toBe(previous);
	});

	it("shows the draft where the reference will be inserted", () => {
		// Heading, empty paragraph, paragraph, list of two items and an empty one.
		let cases: [string, (blocks: ElementNode[]) => LexicalNode, number][] = [
			["empty paragraph", blocks => blocks[1]!, 0],
			["start of a paragraph", blocks => blocks[2]!.getFirstDescendant()!, 0],
			["middle of a paragraph", blocks => blocks[2]!.getFirstDescendant()!, 2],
			["start of the first list item", blocks => blocks[3]!.getFirstDescendant()!, 0],
			["start of a later list item", blocks => blocks[3]!.getLastDescendant()!, 0],
		];
		for (let [label, at, offset] of cases) {
			let editor = createHeadlessEditor({
				nodes: [HeadingNode, ListNode, ListItemNode, ResearchNode],
				onError: error => {
					throw error;
				},
			});
			let expected: string | undefined;
			let actual: string | undefined;
			editor.update(() => {
				let blocks: ElementNode[] = [
					$createHeadingNode("h1").append($createTextNode("Heading")),
					$createParagraphNode(),
					$createParagraphNode().append($createTextNode("Para")),
					$createListNode("bullet").append(
						$createListItemNode().append($createTextNode("one")),
						$createListItemNode().append($createTextNode("two")),
					),
				];
				$getRoot().append(...blocks);
				let node = at(blocks);
				let attachment = $draftAttachment(node.getKey(), offset)!;
				let index = blocks.findIndex(block => block.getKey() === attachment.key);
				// The block the draft visibly follows. An empty anchor line collapses under the draft.
				let after = attachment.placement === "before" || !blocks[index]!.getTextContentSize()
					? index - 1
					: index;
				actual = blocks[after]?.getTextContent();
				if ($isTextNode(node)) node.select(offset, offset);
				else node.selectStart();
				$insertNodes([$createResearchNode("r")]);
			}, { discrete: true });
			editor.read(() => {
				let reference = $getRoot().getChildren().find(child => child.getType() === "plan-research");
				let before = reference?.getPreviousSibling();
				expected = before?.getTextContent();
			});
			// A split block stays whole in the DOM, so the draft follows all of it.
			expect({ label, follows: actual?.startsWith(expected!) }).toEqual({ label, follows: true });
		}
	});

	it("explains an unresolved saved position without blocking submission", async () => {
		let module = await import("./research");
		expect(module.UNRESOLVED_DRAFT).toContain("cannot yet be placed");
	});
});
