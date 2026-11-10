import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

/**
 * The parts of GitHub's Markdown that a Chat message reads: pipe tables, strikethrough written
 * with two tildes, and task lists. remark-gfm also reads footnotes and bare URLs, and in Chat both
 * were always plain text (a footnote would draw a second list of links and ids, and a bare address
 * would become a link nobody wrote), so this takes only the three parts.
 */
export function messageGfmRemarkPlugin(this: { data(): unknown }) {
	let data = this.data() as {
		micromarkExtensions?: unknown[];
		fromMarkdownExtensions?: unknown[];
	};
	(data.micromarkExtensions ??= []).push(
		gfmTable(),
		gfmStrikethrough({ singleTilde: false }),
		gfmTaskListItem(),
	);
	(data.fromMarkdownExtensions ??= []).push(
		gfmTableFromMarkdown(),
		gfmStrikethroughFromMarkdown(),
		gfmTaskListItemFromMarkdown(),
	);
}
