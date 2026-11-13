import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

type Plugin = (this: { data(): unknown }) => void;
type MicromarkExtension = ReturnType<typeof gfmTable>;
type FromMarkdownExtension = ReturnType<typeof gfmTableFromMarkdown>;

export type MessageGfmExtensions = {
	extensions: MicromarkExtension[];
	mdastExtensions: FromMarkdownExtension[];
};

const TABLE = 1;
const STRIKETHROUGH = 2;
const TASKS = 4;
const ADDRESSES = 8;

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
 * match: a delimiter row for a table, a tilde for strikethrough, a bracket around a space, a line
 * ending, `x` or `X` for a task box, and `http://` or `https://` for a web address. A single tilde
 * is enough, because the strikethrough syntax, even with single-tilde strikethrough off, changes how
 * emphasis around a tilde parses. Each test only has to be necessary, never sufficient, since a
 * part read for a source that has no use for it changes nothing.
 */
function partsOf(source: string): number {
	return (DELIMITER_ROW.test(source) ? TABLE : 0) | (source.includes("~") ? STRIKETHROUGH : 0)
		| (TASK_BOX.test(source) ? TASKS : 0) | (WEB_ADDRESS.test(source) ? ADDRESSES : 0);
}

/** A web address written out, which is the only kind of bare text Chat makes a link of. */
const WEB_ADDRESS = /https?:\/\//i;

type Node = {
	type: string;
	value?: string;
	url?: string;
	children?: Node[];
	position?: { start: { offset?: number }; end: { offset?: number } };
};

/**
 * GitHub's literal links also read `www.example.com` and `ana@example.com`, which Chat leaves as
 * the text they were written as: only an address written with `http://` or `https://` becomes a
 * link, as Slack does. A literal is told from a written link (`[a](…)`, `<https://…>`) by having
 * no brackets around its text, so its text starts and ends where it does; one made after the parse
 * has no position at all. The text a literal leaves is joined to the text beside it.
 */
function keepWebAddresses(tree: Node): void {
	let visit = (node: Node) => {
		if (!node.children) return;
		let children: Node[] = [];
		for (let child of node.children) {
			let text = child.children?.length === 1 ? child.children[0] : undefined;
			let literal = child.type === "link" && text?.type === "text"
				&& (!child.position || !text.position
					|| child.position.start.offset === text.position.start.offset
						&& child.position.end.offset === text.position.end.offset);
			if (literal && !WEB_ADDRESS.test(text!.value?.slice(0, 8) ?? "")) {
				let previous = children.at(-1);
				if (previous?.type === "text") {
					previous.value += text!.value ?? "";
					delete previous.position;
				} else children.push({ type: "text", value: text!.value ?? "" });
				continue;
			}
			let previous = children.at(-1);
			if (child.type === "text" && previous?.type === "text" && !previous.position) {
				previous.value += child.value ?? "";
				continue;
			}
			visit(child);
			children.push(child);
		}
		node.children = children;
	};
	visit(tree);
}

function extensionsFor(parts: number): MessageGfmExtensions {
	let extensions: MicromarkExtension[] = [];
	let mdastExtensions: FromMarkdownExtension[] = [];
	if (parts & TABLE) {
		extensions.push(gfmTable());
		mdastExtensions.push(gfmTableFromMarkdown());
	}
	if (parts & STRIKETHROUGH) {
		extensions.push(gfmStrikethrough({ singleTilde: false }));
		mdastExtensions.push(gfmStrikethroughFromMarkdown());
	}
	if (parts & TASKS) {
		extensions.push(gfmTaskListItem());
		mdastExtensions.push(gfmTaskListItemFromMarkdown());
	}
	if (parts & ADDRESSES) {
		extensions.push(gfmAutolinkLiteral());
		mdastExtensions.push(gfmAutolinkLiteralFromMarkdown(), {
			transforms: [keepWebAddresses],
		} as unknown as FromMarkdownExtension);
	}
	return { extensions, mdastExtensions };
}

function plugin(parts: number): Plugin {
	return function() {
		let data = this.data() as {
			micromarkExtensions?: unknown[];
			fromMarkdownExtensions?: unknown[];
		};
		let { extensions, mdastExtensions } = extensionsFor(parts);
		(data.micromarkExtensions ??= []).push(...extensions);
		(data.fromMarkdownExtensions ??= []).push(...mdastExtensions);
	};
}

let plugins = new Map<number, Plugin>();
let extensionSets = new Map<number, MessageGfmExtensions>();

/** The same GFM extensions as `messageGfmRemarkPlugin`, shaped for `mdast-util-from-markdown`. */
export function messageGfmExtensions(source: string): MessageGfmExtensions | undefined {
	let parts = partsOf(source);
	if (!parts) return undefined;
	let held = extensionSets.get(parts);
	if (!held) extensionSets.set(parts, held = extensionsFor(parts));
	return held;
}

/**
 * The parts of GitHub's Markdown that a Chat message reads: pipe tables, strikethrough written
 * with two tildes, task lists, and a web address written out (`https://…`), which becomes a link
 * as it does in Slack. remark-gfm also reads footnotes, which in Chat stay plain text (they would
 * draw a second list of links and ids), and `www.` and email literals (`keepWebAddresses`).
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

/** Every part whatever the source, for the test that the choice above never changes a tree. */
export let allMessageGfmParts: Plugin = plugin(TABLE | STRIKETHROUGH | TASKS | ADDRESSES);
