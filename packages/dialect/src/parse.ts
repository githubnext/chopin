/**
 * MDX source -> MDAST.
 *
 * Ace owns parsing rather than reusing MDXEditor's, because the dialect is a
 * strict subset: only the extensions below are enabled, so constructs like ESM
 * imports and `{expressions}` never become executable nodes in the first place.
 * Anything that still parses is rejected by `validate`.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { mathFromMarkdown } from "mdast-util-math";
import { mdxJsxFromMarkdown } from "mdast-util-mdx-jsx";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { math } from "micromark-extension-math";
import { mdxJsx } from "micromark-extension-mdx-jsx";
import { mdxMd } from "micromark-extension-mdx-md";

import type { Root } from "mdast";

/** Thrown when the source is not parseable at all. `validate` reports dialect violations. */
export class PlanParseError extends Error {
	override readonly name = "PlanParseError";
}

/**
 * Syntax extensions. Notably absent: `mdxjs`/`mdxExpression` (ESM and JS
 * expressions) and any raw-HTML extension.
 */
function syntax() {
	return [
		gfmTable(),
		gfmStrikethrough({ singleTilde: false }),
		gfmTaskListItem(),
		gfmFootnote(),
		math(),
		// No `acorn`: attribute expressions cannot be parsed into JS, and the
		// validator rejects any attribute that is not a plain string.
		mdxJsx(),
		// Turns off raw HTML, autolinks and indented code. Without it micromark's
		// HTML constructs shadow JSX, so `<Callout>` would parse as an opaque
		// `html` node, and indenting a nested component would turn it into code.
		mdxMd(),
	];
}

function mdast() {
	return [
		gfmTableFromMarkdown(),
		gfmStrikethroughFromMarkdown(),
		gfmTaskListItemFromMarkdown(),
		gfmFootnoteFromMarkdown(),
		mathFromMarkdown(),
		mdxJsxFromMarkdown(),
	];
}

/**
 * Parse MDX into MDAST.
 *
 * @throws {PlanParseError} when the source cannot be parsed.
 */
export function parse(source: string): Root {
	try {
		return fromMarkdown(source, {
			extensions: syntax(),
			mdastExtensions: mdast(),
		});
	} catch (err) {
		let reason = err instanceof Error ? err.message : String(err);
		throw new PlanParseError(`Unable to parse plan MDX: ${reason}`, { cause: err });
	}
}
