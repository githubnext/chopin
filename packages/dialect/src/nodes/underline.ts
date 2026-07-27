/**
 * Underline as a formatting mark.
 *
 * Markdown has no underline syntax and the dialect has no raw HTML, so it is
 * serialised as `<Underline>`. Internally it is Lexical's native underline text
 * format rather than a wrapper node: formatting a selection splits and merges
 * text runs constantly, which element nodes model badly and which Yjs merges
 * correctly when it is a format flag.
 *
 * Because it carries no state it needs no id, so applying it stays local and
 * instant instead of requiring a server round-trip for an identifier.
 *
 * MDXEditor's text visitor already round-trips the underline format, but writes
 * it as `<u>`. Import maps our spelling onto the format; export renames the tag
 * back, which is cheaper and far less fragile than replacing that visitor and
 * reimplementing its format-nesting rules.
 */

import { IS_UNDERLINE } from "@mdxeditor/editor";

import type { MdastImportVisitor } from "@mdxeditor/editor";
import type { Nodes, Parent } from "mdast";
import type { MdxJsxTextElement } from "mdast-util-mdx-jsx";

/** How underline appears in plan source. */
export const UNDERLINE = "Underline";

/** What MDXEditor's built-in text visitor emits. */
const NATIVE = "u";

export const MdastUnderlineVisitor: MdastImportVisitor<MdxJsxTextElement> = {
	testNode: node => node.type === "mdxJsxTextElement" && node.name === UNDERLINE,
	visitNode({ mdastNode, lexicalParent, actions }) {
		actions.addFormatting(IS_UNDERLINE, mdastNode as unknown as Parent);
		actions.visitChildren(mdastNode as unknown as Parent, lexicalParent);
	},
	// Must outrank MDXEditor's generic JSX visitor, which would otherwise turn
	// this into an opaque decorator node.
	priority: 100,
};

/** Rewrite exported `<u>` elements to the dialect's spelling, in place. */
export function normalizeMarks(node: Nodes): void {
	if (node.type === "mdxJsxTextElement" && node.name === NATIVE) {
		node.name = UNDERLINE;
	}
	for (let child of (node as Parent).children ?? []) normalizeMarks(child);
}
