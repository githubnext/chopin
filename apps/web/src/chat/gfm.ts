import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

type Plugin = (this: { data(): unknown }) => void;

const TABLE = 1;
const STRIKETHROUGH = 2;
const TASKS = 4;

/**
 * A table needs a delimiter row, and micromark reads one only if it holds a pipe or a colon: a row
 * of nothing but hyphens, spaces, tabs, pipes, colons and the `>` of a quote, with at least one
 * hyphen. A column with no pipe at all is a table too (`a` over `:-`), so a pipe in the text is not
 * the test; a row like that is.
 *
 * Two lookaheads find the pipe or colon and the hyphen, and the row itself is one run of the
 * class: a run that holds the hyphen as a required step between two runs of the same class would
 * try every hyphen of a long line as that step, and a message may be 64 KiB. Each line is read
 * once. Only the line's own run is searched, so a line separator that Markdown does not know
 * (U+2028) never joins a row to a pipe after it.
 */
const DELIMITER_ROW = /^(?=[ \t>|:-]*[|:])(?=[ \t>|:-]*-)[ \t>|:-]*$/m;

/**
 * A task box is a bracket around a space, a line ending, `x` or `X`. A line ending inside it
 * carries the container's prefix on the next line (the indentation of a list item, the `>` of a
 * quote), and micromark reads the box across it (`- [` over `  ] a`), so the test allows
 * whitespace, `>` and at most one `x` between the brackets, which is more than the syntax needs.
 * The `x` carries the run after it, so the two runs never share a character and a long run of
 * spaces after a lone bracket is read once.
 */
const TASK_BOX = /\[[\s>]*(?:[xX][\s>]*)?\]/;

/**
 * Which parts of GitHub's Markdown a source can use, from marks without which the syntax cannot
 * match: a delimiter row for a table, a tilde for strikethrough, and a bracket around a space,
 * a line ending, `x` or `X` for a task box. A single tilde is enough, because the strikethrough
 * syntax, even with single-tilde strikethrough off, changes how emphasis around a tilde parses. Each test only has to be necessary, never sufficient,
 * since a part read for a source that has no use for it changes nothing.
 */
function partsOf(source: string): number {
	return (DELIMITER_ROW.test(source) ? TABLE : 0) | (source.includes("~") ? STRIKETHROUGH : 0)
		| (TASK_BOX.test(source) ? TASKS : 0);
}

function plugin(parts: number): Plugin {
	return function() {
		let data = this.data() as {
			micromarkExtensions?: unknown[];
			fromMarkdownExtensions?: unknown[];
		};
		let syntax = (data.micromarkExtensions ??= []);
		let tree = (data.fromMarkdownExtensions ??= []);
		if (parts & TABLE) {
			syntax.push(gfmTable());
			tree.push(gfmTableFromMarkdown());
		}
		if (parts & STRIKETHROUGH) {
			syntax.push(gfmStrikethrough({ singleTilde: false }));
			tree.push(gfmStrikethroughFromMarkdown());
		}
		if (parts & TASKS) {
			syntax.push(gfmTaskListItem());
			tree.push(gfmTaskListItemFromMarkdown());
		}
	};
}

let plugins = new Map<number, Plugin>();

/**
 * The parts of GitHub's Markdown that a Chat message reads: pipe tables, strikethrough written
 * with two tildes, and task lists. remark-gfm also reads footnotes and bare URLs, and in Chat both
 * were always plain text (a footnote would draw a second list of links and ids, and a bare address
 * would become a link nobody wrote), so this takes only the three parts.
 *
 * It takes only those the source can use. The table's syntax is tried at the start of every line
 * of every message, and most messages have no delimiter row, so a source with none of the marks is
 * read with no extension at all and the plugin it gets is `undefined`. The tree is the same: a part
 * a source has no mark for could not have changed it (`gfm.test.tsx` reads sources both ways).
 */
export function messageGfmRemarkPlugin(source: string): Plugin | undefined {
	let parts = partsOf(source);
	if (!parts) return undefined;
	let held = plugins.get(parts);
	if (!held) plugins.set(parts, held = plugin(parts));
	return held;
}

/** All three parts whatever the source, for the test that the choice above never changes a tree. */
export let allMessageGfmParts: Plugin = plugin(TABLE | STRIKETHROUGH | TASKS);
