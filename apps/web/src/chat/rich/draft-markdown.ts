/**
 * The Chat draft as blocks of formatted text, and the Markdown it is sent as.
 *
 * A message is Markdown, and the rich draft shows what that Markdown means: bold, italic and
 * struck words, inline code, links, bulleted and numbered lists and code blocks. `parseDraft` reads
 * a message's Markdown into blocks and `serializeDraft` writes them back. Writing what was read
 * gives the same Markdown character for character: a block whose Markdown the draft would write
 * differently (a `*` for emphasis, a quote, a table, an indented line) is kept as its own lines of
 * plain text, which is how the person typed it and how it is sent. Every line of the Markdown is a
 * line of the draft: blank lines are empty paragraphs, except the one blank line that ends a list
 * before a paragraph, which the Markdown needs so the paragraph is not read as part of the list.
 *
 * `serializeDraft` also says where each piece of text is in the Markdown, so a caret in the draft
 * and an offset in the Markdown (where `@`, `#` and `/` are found and references are kept) can be
 * told one from the other.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

import type { ReferenceDraft } from "../references";

export type Marks = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };

/** What a reference asks the server for, without its range, which is wherever it is written. */
export type ReferencePayload = ReferenceDraft extends infer R
	? R extends { start: number; end: number } ? Omit<R, "start" | "end"> : never
	: never;

export type DraftLink = { url: string; key?: string };

export type Leaf =
	| { type: "text"; text: string; marks: Marks; link?: DraftLink; key?: string }
	| {
		type: "reference";
		text: string;
		reference: ReferencePayload;
		marks: Marks;
		link?: DraftLink;
		key?: string;
	}
	| { type: "break"; key?: string };

export type DraftItem = { leaves: Leaf[]; key?: string };

export type Block =
	| { type: "paragraph"; leaves: Leaf[]; key?: string }
	| { type: "list"; ordered: boolean; start: number; items: DraftItem[]; key?: string }
	| { type: "code"; lang: string; text: string; key?: string };

/** Where a run of a leaf's text is in the Markdown: `length` characters from `at` in the leaf. */
export type Segment = { at: number; md: number; length: number };

/** A keyed piece of the draft and where it is in the Markdown, in the order the draft reads. */
export type Slot =
	| { kind: "leaf"; key: string; segments: Segment[]; token: boolean }
	| { kind: "break"; key: string; md: number }
	| { kind: "element"; key: string; start: number; end: number; empty: boolean };

export type Serialized = { markdown: string; references: ReferenceDraft[]; slots: Slot[] };

const MASK = "\uE000";
const ITALIC = "\uE001";
const ITALIC_CLOSE = "\uE002";
const ORDER = ["bold", "italic", "strike"] as const;
type Mark = (typeof ORDER)[number];

function marker(mark: Mark, closing = false): string {
	return mark === "bold" ? "**" : mark === "strike" ? "~~" : closing ? ITALIC_CLOSE : ITALIC;
}

function sameLink(left?: DraftLink, right?: DraftLink): boolean {
	return left === right || (!!left && !!right && left.key !== undefined && left.key === right.key);
}

function whitespaceSplit(
	leaves: Leaf[],
): Array<{ leaf: Leaf; text: string; at: number; marks: Marks }> {
	let pieces: Array<{ leaf: Leaf; text: string; at: number; marks: Marks }> = [];
	let marksOf = (leaf: Leaf | undefined): Marks => leaf && leaf.type !== "break" ? leaf.marks : {};
	let common = (left: Marks, right: Marks): Marks => ({
		bold: left.bold && right.bold,
		italic: left.italic && right.italic,
		strike: left.strike && right.strike,
		code: left.code,
	});
	for (let [index, leaf] of leaves.entries()) {
		if (leaf.type === "break") {
			pieces.push({ leaf, text: "", at: 0, marks: {} });
			continue;
		}
		let { marks, text } = leaf;
		// A mark cannot open before a space or close after one, so a space at the edge of a marked
		// run takes only the marks its neighbour on that side shares.
		if (leaf.type === "text" && !marks.code && (marks.bold || marks.italic || marks.strike)) {
			let lead = /^\s+/.exec(text)?.[0].length ?? 0;
			let trail = lead === text.length ? 0 : /\s+$/.exec(text)?.[0].length ?? 0;
			if (lead) {
				pieces.push({
					leaf,
					text: text.slice(0, lead),
					at: 0,
					marks: common(marks, marksOf(leaves[index - 1])),
				});
			}
			if (lead < text.length) {
				pieces.push({ leaf, text: text.slice(lead, text.length - trail), at: lead, marks });
			}
			if (trail) {
				pieces.push({
					leaf,
					text: text.slice(text.length - trail),
					at: text.length - trail,
					marks: common(marks, marksOf(leaves[index + 1])),
				});
			}
			continue;
		}
		pieces.push({ leaf, text, at: 0, marks });
	}
	return pieces;
}

function codeFence(text: string): string {
	let longest = 0;
	for (let run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(longest + 1);
}

/**
 * Emphasis is `_` unless a letter or digit touches the pair from outside, where only `*` is read.
 * The marks are written as placeholders, one for an opening and one for a closing, and resolved a
 * pair at a time once the line is whole; each is one character, so no offset moves.
 */
function resolveItalics(text: string): string {
	let chars = [...text];
	let opened: number[] = [];
	let letter = (value: string | undefined) => !!value && /[\p{L}\p{N}]/u.test(value);
	for (let index = 0; index < chars.length; index++) {
		if (chars[index] === ITALIC) opened.push(index);
		else if (chars[index] === ITALIC_CLOSE) {
			let open = opened.pop()!;
			let mark = letter(chars[open - 1]) || letter(chars[index + 1]) ? "*" : "_";
			chars[open] = mark;
			chars[index] = mark;
		}
	}
	return chars.join("");
}

function writeInline(
	leaves: Leaf[],
	base: number,
	slots: Slot[],
	references: ReferenceDraft[],
): string {
	let out = "";
	let open: Mark[] = [];
	let link: DraftLink | undefined;
	let segments = new Map<Leaf, Segment[]>();
	let closeTo = (keep: Marks) => {
		let deepest = open.findIndex(mark => !keep[mark]);
		if (deepest < 0) return;
		for (let index = open.length - 1; index >= deepest; index--) out += marker(open[index]!, true);
		open.length = deepest;
	};
	let closeLink = () => {
		if (!link) return;
		closeTo({});
		out += `](${link.url})`;
		link = undefined;
	};
	for (let { leaf, text, at, marks } of whitespaceSplit(leaves)) {
		if (leaf.type === "break") {
			closeTo({});
			if (leaf.key) slots.push({ kind: "break", key: leaf.key, md: base + out.length });
			out += "\n";
			continue;
		}
		if (!sameLink(leaf.link, link)) {
			closeLink();
			if (leaf.link) {
				out += "[";
				link = leaf.link;
			}
		}
		closeTo(marks);
		for (let mark of ORDER) {
			if (marks[mark] && !open.includes(mark)) {
				open.push(mark);
				out += marker(mark);
			}
		}
		let fence = marks.code && leaf.type === "text" ? codeFence(text) : "";
		out += fence;
		let start = base + out.length;
		let list = segments.get(leaf);
		if (!list) {
			segments.set(leaf, list = []);
			if (leaf.key) {
				slots.push({
					kind: "leaf",
					key: leaf.key,
					segments: list,
					token: leaf.type === "reference",
				});
			}
		}
		list.push({ at, md: start, length: text.length });
		if (leaf.type === "reference") {
			references.push({ ...leaf.reference, start, end: start + text.length } as ReferenceDraft);
		}
		out += text + fence;
	}
	closeLink();
	closeTo({});
	return resolveItalics(out);
}

/** Whether the paragraphs from `index` on, up to the next list or code block, hold any words. */
function wordsFollow(blocks: readonly Block[], index: number): boolean {
	for (let block of blocks.slice(index)) {
		if (block.type !== "paragraph") return false;
		if (block.leaves.length > 0) return true;
	}
	return false;
}

/** The Markdown of the draft, its references, and where each keyed piece of it is. */
export function serializeDraft(blocks: readonly Block[]): Serialized {
	let markdown = "";
	let references: ReferenceDraft[] = [];
	let slots: Slot[] = [];
	for (let [index, block] of blocks.entries()) {
		if (index > 0) {
			markdown += "\n";
			// Without a blank line the words after a list would be read as part of its last item.
			if (blocks[index - 1]!.type === "list" && wordsFollow(blocks, index)) markdown += "\n";
		}
		let start = markdown.length;
		let element = slots.length;
		if (block.key) slots.push({ kind: "element", key: block.key, start, end: start, empty: false });
		if (block.type === "paragraph") {
			markdown += writeInline(block.leaves, markdown.length, slots, references);
		} else if (block.type === "list") {
			for (let [position, item] of block.items.entries()) {
				if (position > 0) markdown += "\n";
				markdown += block.ordered ? `${block.start + position}. ` : "- ";
				let itemStart = markdown.length;
				let itemSlot = slots.length;
				if (item.key) {
					slots.push({
						kind: "element",
						key: item.key,
						start: itemStart,
						end: itemStart,
						empty: false,
					});
				}
				markdown += writeInline(item.leaves, markdown.length, slots, references);
				if (item.key) {
					slots[itemSlot] = {
						kind: "element",
						key: item.key,
						start: itemStart,
						end: markdown.length,
						empty: item.leaves.length === 0,
					};
				}
			}
		} else {
			markdown += `\`\`\`${block.lang}\n`;
			start = markdown.length;
			markdown += block.text;
			if (block.key) {
				slots[element] = {
					kind: "element",
					key: block.key,
					start,
					end: markdown.length,
					empty: true,
				};
			}
			markdown += "\n```";
			continue;
		}
		if (block.key) {
			slots[element] = {
				kind: "element",
				key: block.key,
				start,
				end: markdown.length,
				empty: block.type === "paragraph" && block.leaves.length === 0,
			};
		}
	}
	return { markdown, references, slots };
}

type Position = {
	start: { line: number; offset?: number };
	end: { line: number; offset?: number };
};
type MdNode = {
	type: string;
	position?: Position;
	children?: MdNode[];
	value?: string;
	url?: string;
	title?: string | null;
	ordered?: boolean | null;
	start?: number | null;
	spread?: boolean | null;
	checked?: boolean | null;
	lang?: string | null;
	meta?: string | null;
};

/** Read a message's Markdown, and the references over its text, as the draft's blocks. */
export function parseDraft(markdown: string, references: readonly ReferenceDraft[] = []): Block[] {
	let sorted = [...references]
		.filter(reference =>
			reference.start >= 0 && reference.end > reference.start && reference.end <= markdown.length
		)
		.sort((left, right) => left.start - right.start)
		.filter((reference, index, list) => index === 0 || reference.start >= list[index - 1]!.end);
	// A reference's words are opaque: masked, so nothing in them is read as Markdown.
	let masked = markdown;
	for (let reference of sorted) {
		masked = masked.slice(0, reference.start)
			+ MASK.repeat(reference.end - reference.start)
			+ masked.slice(reference.end);
	}
	let lines = markdown.split("\n");
	let lineStart: number[] = [];
	let offset = 0;
	for (let line of lines) {
		lineStart.push(offset);
		offset += line.length + 1;
	}

	let textLeaves = (from: number, to: number, marks: Marks, link?: DraftLink): Leaf[] => {
		let leaves: Leaf[] = [];
		let push = (start: number, end: number) => {
			let parts = markdown.slice(start, end).split("\n");
			for (let [index, part] of parts.entries()) {
				if (index > 0) leaves.push({ type: "break" });
				if (part) {
					leaves.push({ type: "text", text: part, marks: { ...marks }, ...(link ? { link } : {}) });
				}
			}
		};
		let at = from;
		for (let reference of sorted) {
			if (reference.end <= at || reference.start >= to) continue;
			if (reference.start < at || reference.end > to) continue;
			push(at, reference.start);
			let { start: _start, end: _end, ...payload } = reference;
			leaves.push({
				type: "reference",
				text: markdown.slice(reference.start, reference.end),
				reference: payload as ReferencePayload,
				marks: { ...marks },
				...(link ? { link } : {}),
			});
			at = reference.end;
		}
		push(at, to);
		return leaves;
	};

	let links = 0;
	let inline = (nodes: readonly MdNode[], marks: Marks, link?: DraftLink): Leaf[] | undefined => {
		let leaves: Leaf[] = [];
		for (let node of nodes) {
			let from = node.position?.start.offset;
			let to = node.position?.end.offset;
			if (from === undefined || to === undefined) return undefined;
			let children = (more: Marks, inner = link) =>
				inline(node.children ?? [], { ...marks, ...more }, inner);
			let next: Leaf[] | undefined;
			if (node.type === "strong") next = children({ bold: true });
			else if (node.type === "emphasis") next = children({ italic: true });
			else if (node.type === "delete") next = children({ strike: true });
			else if (node.type === "inlineCode") {
				if (masked.slice(from, to).includes(MASK)) return undefined;
				next = [{
					type: "text",
					text: node.value ?? "",
					marks: { ...marks, code: true },
					...(link ? { link } : {}),
				}];
			} else if (node.type === "link") {
				if (link || node.title) return undefined;
				next = children({}, { url: node.url ?? "", key: `link-${++links}` });
			} else next = textLeaves(from, to, marks, link);
			if (!next) return undefined;
			leaves.push(...next);
		}
		return leaves;
	};

	let convert = (node: MdNode): Block | undefined => {
		if (node.type === "paragraph") {
			let leaves = inline(node.children ?? [], {});
			return leaves && { type: "paragraph", leaves };
		}
		if (node.type === "list" && !node.spread) {
			let items: DraftItem[] = [];
			for (let item of node.children ?? []) {
				if (item.type !== "listItem" || item.spread || (item.checked ?? null) !== null) {
					return undefined;
				}
				let content = item.children ?? [];
				if (content.length === 0) items.push({ leaves: [] });
				else if (content.length === 1 && content[0]!.type === "paragraph") {
					let leaves = inline(content[0]!.children ?? [], {});
					if (!leaves) return undefined;
					items.push({ leaves });
				} else return undefined;
			}
			return { type: "list", ordered: !!node.ordered, start: node.start ?? 1, items };
		}
		if (node.type === "code" && !node.meta) {
			let from = node.position?.start.offset ?? 0;
			let to = node.position?.end.offset ?? 0;
			if (masked.slice(from, to).includes(MASK)) return undefined;
			return { type: "code", lang: node.lang ?? "", text: node.value ?? "" };
		}
		return undefined;
	};

	let literal = (first: number, last: number): Block[] => {
		let blocks: Block[] = [];
		for (let line = first; line <= last; line++) {
			let start = lineStart[line - 1]!;
			blocks.push({
				type: "paragraph",
				leaves: textLeaves(start, start + lines[line - 1]!.length, {}),
			});
		}
		return blocks;
	};

	let tree = fromMarkdown(masked, {
		extensions: [gfmStrikethrough({ singleTilde: false })],
		mdastExtensions: [gfmStrikethroughFromMarkdown()],
	}) as unknown as MdNode;
	let blocks: Block[] = [];
	let next = 1;
	for (let node of tree.children ?? []) {
		let first = node.position?.start.line ?? next;
		let last = node.position?.end.line ?? first;
		if (first < next) first = next;
		if (last < first) continue;
		let source = lines.slice(first - 1, last).join("\n");
		let block = convert(node);
		// A block is drawn as formatting only where the draft writes it back as it was written.
		let drawn = block && serializeDraft([block]).markdown === source
			? [block]
			: literal(first, last);
		let gap = first - next;
		if (gap > 0 && blocks.at(-1)?.type === "list" && drawn[0]!.type === "paragraph") gap--;
		for (let index = 0; index < gap; index++) blocks.push({ type: "paragraph", leaves: [] });
		blocks.push(...drawn);
		next = last + 1;
	}
	for (let line = next; line <= lines.length; line++) {
		blocks.push({ type: "paragraph", leaves: [] });
	}
	return blocks;
}
