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

import type { Root } from "mdast";

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
	resourceLink: false,
	tightDefinitions: true,
} as const;

/**
 * How each node type is written.
 *
 * Exported because the browser editor keeps a second serialiser of its own and
 * needs the same answer: MDXEditor writes the document out on every update, and
 * a node type it cannot handle throws rather than degrades. Two lists would
 * drift, and the drift is silent — so there is one.
 */
export function extensions() {
	return [
		gfmTableToMarkdown({ tableCellPadding: true, tablePipeAlign: true }),
		gfmStrikethroughToMarkdown(),
		gfmTaskListItemToMarkdown(),
		gfmFootnoteToMarkdown(),
		mathToMarkdown(),
		mdxJsxToMarkdown(),
	];
}

/** Serialise a plan tree to canonical MDX. */
export function serialize(root: Root): string {
	return toMarkdown(root, { ...OPTIONS, extensions: extensions() });
}
