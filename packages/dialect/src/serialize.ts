/**
 * MDAST -> MDX source.
 *
 * Serialisation is deterministic: the same tree always produces the same bytes,
 * regardless of how the content was authored. Plans are not byte-preserving, so
 * canonical output is what gets persisted, diffed and handed to the agent.
 */

import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemToMarkdown } from "mdast-util-gfm-task-list-item";
import { mathToMarkdown } from "mdast-util-math";
import { mdxJsxToMarkdown } from "mdast-util-mdx-jsx";

import type { Nodes, Root } from "mdast";
import type { Handle, Unsafe } from "mdast-util-to-markdown";

/**
 * Fixed formatting. These are part of the persisted contract: changing one
 * rewrites every plan on its next edit, so treat changes as a migration.
 */
const OPTIONS = {
	bullet: "-",
	listItemIndent: "one",
	rule: "-",
	ruleRepetition: 3,
	emphasis: "_",
	strong: "*",
	fence: "`",
	fences: true,
	incrementListMarker: true,
	// MDX has no autolinks: `<https://…>` parses as a JSX tag and fails, so a
	// link whose text is its URL must stay `[url](url)`. No stored plan can
	// hold the autolink form, so this changes no persisted bytes.
	resourceLink: true,
	tightDefinitions: true,
} as const;

/**
 * micromark searches the whole paragraph for an opener at each unescaped `]`,
 * so prose full of them re-parses in quadratic time. Escaping every one keeps
 * that bounded. Mirrors the default rule for `[`.
 */
const UNSAFE: Unsafe[] = [{
	character: "]",
	inConstruct: "phrasing",
	notInConstruct: [
		"autolink",
		"destinationLiteral",
		"destinationRaw",
		"reference",
		"titleQuote",
		"titleApostrophe",
	],
}];

/**
 * How each node type is written.
 *
 * Exported because the browser editor keeps a second serialiser of its own and
 * needs the same answer: MDXEditor writes the document out on every update, and
 * a node type it cannot handle throws rather than degrades. Two lists would
 * drift, and the drift is silent — so there is one.
 */
export function extensions() {
	let jsx = mdxJsxToMarkdown();
	let original = jsx.handlers!.mdxJsxTextElement!;
	let image: Handle = (node: Nodes, parent, state, info) => {
		let component = (node.type === "mdxJsxTextElement" || node.type === "mdxJsxFlowElement")
				&& node.name === "Image"
			? node
			: undefined;
		let escaped = node;
		if (component) {
			// Upstream escapes quotes but leaves authored entity-like strings open to decoding.
			escaped = {
				...component,
				attributes: component.attributes.map(attribute =>
					attribute.type === "mdxJsxAttribute" && typeof attribute.value === "string"
						? { ...attribute, value: attribute.value.replace(/&/g, "&#38;") }
						: attribute
				),
			};
		}
		let output = original(escaped, parent, state, info);
		// JSX attributes bypass GFM's escaping; literal pipes and line endings split table cells.
		return component && state.stack.includes("tableCell")
			? output.replace(/\|/g, "&#124;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;")
			: output;
	};
	jsx.handlers!.mdxJsxTextElement = Object.assign(image, original);
	jsx.handlers!.mdxJsxFlowElement = jsx.handlers!.mdxJsxTextElement;
	return [
		gfmTableToMarkdown({ tableCellPadding: true, tablePipeAlign: true }),
		gfmStrikethroughToMarkdown(),
		gfmTaskListItemToMarkdown(),
		gfmFootnoteToMarkdown(),
		mathToMarkdown(),
		jsx,
	];
}

/** Serialise a plan tree to canonical MDX. */
export function serialize(root: Root): string {
	return toMarkdown(root, { ...OPTIONS, unsafe: UNSAFE, extensions: extensions() });
}
