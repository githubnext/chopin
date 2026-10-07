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

export type ParseOptions = {
	/**
	 * Parse components. Off, `<Questionnaire>` and every other tag stay literal
	 * text, which is what pasted Markdown needs: it must never be able to mint a
	 * protected projection. Defaults to true.
	 */
	jsx?: boolean;
	/**
	 * Treat `$…$` as inline math. Pasted prose mentions prices far more often
	 * than formulas, so paste keeps only `$$…$$`. Defaults to true.
	 */
	singleDollarMath?: boolean;
};

/**
 * Syntax extensions. Notably absent: `mdxjs`/`mdxExpression` (ESM and JS
 * expressions) and any raw-HTML extension.
 */
function syntax({ jsx = true, singleDollarMath = true }: ParseOptions) {
	return [
		gfmTable(),
		gfmStrikethrough({ singleTilde: false }),
		gfmTaskListItem(),
		gfmFootnote(),
		math({ singleDollarTextMath: singleDollarMath }),
		// No `acorn`: attribute expressions cannot be parsed into JS, and the
		// validator rejects any attribute that is not a plain string.
		...(jsx ? [mdxJsx()] : []),
		// Turns off raw HTML, autolinks and indented code. Without it micromark's
		// HTML constructs shadow JSX, so `<Callout>` would parse as an opaque
		// `html` node, and indenting a nested component would turn it into code.
		mdxMd(),
	];
}

function mdast({ jsx = true }: ParseOptions) {
	return [
		gfmTableFromMarkdown(),
		gfmStrikethroughFromMarkdown(),
		gfmTaskListItemFromMarkdown(),
		gfmFootnoteFromMarkdown(),
		mathFromMarkdown(),
		...(jsx ? [mdxJsxFromMarkdown()] : []),
	];
}

/**
 * Parse MDX into MDAST.
 *
 * @throws {PlanParseError} when the source cannot be parsed.
 */
export function parse(source: string, options: ParseOptions = {}): Root {
	try {
		return fromMarkdown(source, {
			extensions: syntax(options),
			mdastExtensions: mdast(options),
		});
	} catch (err) {
		let reason = err instanceof Error ? err.message : String(err);
		throw new PlanParseError(`Unable to parse plan MDX: ${reason}`, { cause: err });
	}
}
