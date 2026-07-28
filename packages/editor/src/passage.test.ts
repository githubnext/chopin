/**
 * Turning a selection into something the server can check.
 *
 * The client sends block indices, the digests it read them at, and the text it
 * selected — never a position. So the thing worth pinning is that its idea of
 * which blocks a selection covers, and what text that is, matches the server's:
 * the offset is only a hint, but the block indices have to be exact and the
 * quote has to be findable.
 *
 * Resolution and painting are not tested here. Both need real layout, and
 * happy-dom returns zero for every measurement.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $isElementNode, $setSelection } from "lexical";

import { importPlan, registry } from "@chopin/dialect";

import { $describe } from "./passage";

import type { LexicalEditor, TextNode } from "lexical";

const REGISTRY = registry();

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

function editor(source = SOURCE): LexicalEditor {
	let instance = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
	importPlan(instance, source, { registry: REGISTRY });
	return instance;
}

/** The addressable blocks, the way both ends count them. */
function $blocks() {
	return $getRoot().getChildren();
}

/** Select from one offset in a block's text to another, possibly across blocks. */
function select(
	instance: LexicalEditor,
	from: { block: number; at: number },
	to: { block: number; at: number },
) {
	let marked;
	instance.update(() => {
		let all = $blocks();
		let start = all[from.block];
		let end = all[to.block];
		if (!$isElementNode(start) || !$isElementNode(end)) throw new Error("not elements");

		let anchor = start.getAllTextNodes()[0] as TextNode;
		let focus = end.getAllTextNodes()[0] as TextNode;

		let selection = anchor.select(from.at, from.at);
		selection.focus.set(focus.getKey(), to.at, "text");
		$setSelection(selection);
		marked = $describe(selection);
	}, { discrete: true });
	return marked as ReturnType<typeof $describe>;
}

describe("describing a selection", () => {
	it("names the block it sits in, and the text it covers", () => {
		let instance = editor();
		let marked = select(instance, { block: 1, at: 13 }, { block: 1, at: 40 });

		expect(marked?.blocks).toEqual([1]);
		expect(marked?.quote).toBe("caches tiles for 60 seconds");
		expect(marked?.length).toBe("caches tiles for 60 seconds".length);
	});

	it("names every block in a run when the selection crosses one", () => {
		let instance = editor();
		let marked = select(instance, { block: 1, at: 30 }, { block: 2, at: 10 });

		expect(marked?.blocks).toEqual([1, 2]);
		// Blocks join with a newline, which is how the server reads a run too.
		expect(marked?.quote).toBe("60 seconds.\nThe second");
	});

	it("reads the same span whichever way it was dragged", () => {
		let instance = editor();
		let forward = select(instance, { block: 1, at: 13 }, { block: 1, at: 40 });
		let backward = select(instance, { block: 1, at: 40 }, { block: 1, at: 13 });

		expect(backward?.quote).toBe(forward?.quote);
		expect(backward?.offset).toBe(forward?.offset);
	});

	it("describes nothing for a caret", () => {
		let instance = editor();
		expect(select(instance, { block: 1, at: 5 }, { block: 1, at: 5 })).toBeUndefined();
	});

	/** The extent is carried separately, so a long phrase is marked, not refused. */
	it("bounds the quote it sends but not the passage it marks", () => {
		let long = `# Title\n\n${"word ".repeat(400)}\n`;
		let instance = editor(long);
		let marked = select(instance, { block: 1, at: 0 }, { block: 1, at: 1_500 });

		expect(marked!.quote.length).toBeLessThanOrEqual(500);
		expect(marked!.length).toBe(1_500);
	});
});
