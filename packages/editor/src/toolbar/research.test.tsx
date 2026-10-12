import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from "@lexical/list";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
	$createTableCellNode,
	$createTableNode,
	$createTableRowNode,
	TableCellNode,
	TableNode,
	TableRowNode,
} from "@lexical/table";
import { $createResearchNode, ResearchNode } from "@chopin/dialect";
import { $createParagraphNode, $createTextNode, $getRoot, $isTextNode } from "lexical";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { $draftAttachment, $insertResearch } from "./research";

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
		// "split" marks a point inside a block: the reference splits it, the draft follows all of it.
		let cases: [string, (blocks: ElementNode[]) => LexicalNode, number, "split"?][] = [
			["empty paragraph", blocks => blocks[1]!, 0],
			["empty heading", blocks => blocks[5]!, 0],
			["empty quote", blocks => blocks[6]!, 0],
			["start of a paragraph", blocks => blocks[2]!.getFirstDescendant()!, 0],
			["middle of a paragraph", blocks => blocks[2]!.getFirstDescendant()!, 2, "split"],
			["start of the first list item", blocks => blocks[3]!.getFirstDescendant()!, 0],
			["start of a later list item", blocks => blocks[3]!.getLastDescendant()!, 0],
			["table cell", blocks => blocks[4]!.getLastDescendant()!, 1],
		];
		for (let [label, at, offset, split] of cases) {
			let editor = createHeadlessEditor({
				nodes: [
					HeadingNode,
					QuoteNode,
					ListNode,
					ListItemNode,
					TableNode,
					TableRowNode,
					TableCellNode,
					ResearchNode,
				],
				onError: error => {
					throw error;
				},
			});
			let follows: string | undefined;
			let inserted: { previous?: string; parent?: string } = {};
			editor.update(() => {
				let cell = (text: string) =>
					$createTableCellNode().append($createParagraphNode().append($createTextNode(text)));
				let blocks: ElementNode[] = [
					$createHeadingNode("h1").append($createTextNode("Heading")),
					$createParagraphNode(),
					$createParagraphNode().append($createTextNode("Para")),
					$createListNode("bullet").append(
						$createListItemNode().append($createTextNode("one")),
						$createListItemNode().append($createTextNode("two")),
					),
					$createTableNode().append($createTableRowNode().append(cell("A"), cell("B"))),
					$createHeadingNode("h2"),
					$createQuoteNode(),
				];
				$getRoot().append(...blocks);
				let node = at(blocks);
				let attachment = $draftAttachment(node.getKey(), offset)!;
				let children = $getRoot().getChildren();
				let index = children.findIndex(block => block.getKey() === attachment.key);
				// The block the draft visibly follows. An empty anchor line collapses under the draft.
				let after = attachment.placement === "before" || !children[index]!.getTextContentSize()
					? index - 1
					: index;
				follows = children[after]?.getTextContent();
				if ($isTextNode(node)) node.select(offset, offset);
				else node.selectStart();
				$insertResearch($createResearchNode("r"));
			}, { discrete: true });
			editor.read(() => {
				let reference = [...editor.getEditorState()._nodeMap.values()]
					.find(node => node.getType() === "plan-research");
				inserted = {
					previous: reference?.getPreviousSibling()?.getTextContent(),
					parent: reference?.getParent()?.getType(),
				};
			});
			expect({ label, parent: inserted.parent }).toEqual({ label, parent: "root" });
			if (split) {
				expect({ label, follows: follows?.startsWith(inserted.previous!) })
					.toEqual({ label, follows: true });
			} else {
				expect({ label, follows }).toEqual({ label, follows: inserted.previous });
			}
		}
	});

	it("explains an unresolved saved position without blocking submission", async () => {
		let module = await import("./research");
		expect(module.UNRESOLVED_DRAFT).toContain("cannot yet be placed");
	});
});
