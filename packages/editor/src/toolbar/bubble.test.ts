import { describe, expect, it } from "bun:test";
import { $getRoot, $isElementNode, createEditor } from "lexical";

import { $importPlan, registry } from "@chopin/dialect";

import { $block } from "./bubble";

import type { LexicalNode } from "lexical";

const SOURCE = `Plain text.

# Heading one

## Heading two

#### Heading four

> Quoted.

- bulleted

1. numbered

<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note">

Inside a callout.

</Callout>
`;

/** Reads the type from the deepest text of the nth top-level block. */
function at(index: number): string {
	let schema = registry();
	let editor = createEditor({
		nodes: schema.nodes,
		onError: error => {
			throw error;
		},
	});
	editor.update(() => $importPlan(SOURCE, { registry: schema }), { discrete: true });

	return editor.getEditorState().read(() => {
		let node: LexicalNode | null = $getRoot().getChildren()[index] ?? null;
		while ($isElementNode(node)) {
			let child: LexicalNode | null = node.getFirstChild();
			if (!child) break;
			node = child;
		}
		return $block(node);
	});
}

describe("block type under the selection", () => {
	it("reads plain text as text", () => {
		expect(at(0)).toBe("paragraph");
	});

	it("reads a heading as its level", () => {
		expect(at(1)).toBe("h1");
		expect(at(2)).toBe("h2");
	});

	/** The menu offers h1 to h3; an agent may still have written deeper. */
	it("reports a heading it cannot offer rather than mislabelling it", () => {
		expect(at(3)).toBe("h4");
	});

	it("reads a quote", () => {
		expect(at(4)).toBe("quote");
	});

	/** A list item's shape belongs to the list around it. */
	it("reads a list from its parent, not the item", () => {
		expect(at(5)).toBe("bullet");
		expect(at(6)).toBe("number");
	});

	/**
	 * The case that breaks the obvious version: resolving to the top-level
	 * element would answer with the callout, which is not a type anything here
	 * can apply, and would disagree with what converting actually changes.
	 */
	it("reads the paragraph inside a container, not the container", () => {
		expect(at(7)).toBe("paragraph");
	});
});
