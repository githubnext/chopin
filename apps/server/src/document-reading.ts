/**
 * A document as text an agent can read in parts.
 *
 * Atomic's MCP adapter keeps the head and tail of a result longer than 20 KiB of UTF-8 and
 * drops the middle without a word, so one result never carries more than `READ_BYTES` bytes
 * in all: the header, outline, lists, block listing, source and the lines that say how to
 * continue are all counted. The source is the result's last section and is verbatim, so the
 * source sections of the results that `next:` leads through, joined, are the document.
 */
import { parse } from "@chopin/dialect/parse";

import type { Heading, RootContent } from "mdast";

/**
 * The most UTF-8 bytes one whole result may carry, about four fifths of the 20 KiB a harness keeps.
 * A document that does not fit is read in parts.
 */
export const READ_BYTES = 16_000;

/** What a tool description tells a model about reading in parts. */
export const READING_IN_PARTS =
	`One result holds at most ${
		READ_BYTES.toLocaleString("en-US")
	} bytes in all. A document that does not fit returns its outline and first part and a \`next:\` `
	+ "call; make that call, and each one after it, until a result has no `next:`. `offset` (a "
	+ "1-based line), `limit` (most lines; a result may stop sooner, and says so) and `column` (a "
	+ "1-based character in line `offset`, to continue a line too long for one result) read any part.";

/** The most bytes the outline of a large document may take. */
const OUTLINE_BYTES = 2_500;

/** The most bytes each list that comes with the first part of a document may take. */
export const NOTE_BYTES = { brief: 2_000, decisions: 1_500, comments: 1_500 } as const;

/** The longest value a header field or a listed item shows, in characters. */
const FIELD_CHARS = 300;
const ITEM_CHARS = 240;

/**
 * A request for part of a document. `offset` is a 1-based line, `limit` a most-lines count and
 * `column` a 1-based position in line `offset`: the line's characters, then its newline when it
 * has one, counted as Unicode code points, so a piece never splits one.
 */
export type ReadRange = { offset?: number; limit?: number; column?: number };

export class ReadRangeError extends Error {
	override readonly name = "ReadRangeError";
}

export type TextBlock = { index: number; type: string; digest: string };

/** A list that comes with the first part only: trimmed to `bytes`, with `rest` saying what is left out. */
export type Notes = {
	title: string;
	items: string[];
	bytes: number;
	rest: (omitted: number) => string;
};

export type DocumentText = {
	/** Header lines naming the document: id, title, revision and so on. */
	fields: Array<[string, string]>;
	/** Lists shown with the first part only, such as a brief or the decisions. */
	notes?: Notes[];
	source: string;
	/** The top-level blocks an editor addresses; listed beside the lines they start on. */
	blocks?: TextBlock[];
	/** The call that reads on from a position, for `next:`. */
	next: (at: { offset: number; column?: number }) => string;
	range?: ReadRange;
};

type Structure = {
	start: number;
	end: number;
	heading?: { depth: number; title: string };
};

type Window = {
	first: number;
	from: number;
	last: number;
	/** Set when the result ends inside `last`: the column the next result starts at. */
	cut?: number;
	more: boolean;
	/** Set to the limit asked for when this result stops short of it. */
	asked?: number;
	text: string;
	listed: string[];
	/** Set for the first part of a document too large for one result. */
	outline?: string[];
};

export function size(text: string): number {
	return Buffer.byteLength(text);
}

function width(character: string): number {
	let point = character.codePointAt(0)!;
	return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

export function characters(text: string): number {
	let count = 0;
	for (let _ of text) count++;
	return count;
}

/** The longest start of `text` that fits `bytes`, cut between characters. */
function prefix(text: string, bytes: number): string {
	if (size(text) <= bytes) return text;
	let used = 0;
	let end = 0;
	for (let character of text) {
		used += width(character);
		if (used > bytes) break;
		end += character.length;
	}
	return text.slice(0, end);
}

/** The index in `text` of 1-based `column`, counted in characters. */
function indexOfColumn(text: string, column: number): number {
	let index = 0;
	for (let skipped = 1; skipped < column && index < text.length; skipped++) {
		index += text.codePointAt(index)! > 0xffff ? 2 : 1;
	}
	return index;
}

/** `value` as one line of at most `limit` characters, whitespace collapsed. */
export function oneLine(value: string, limit = ITEM_CHARS): string {
	let text = value.replace(/\s+/g, " ").trim();
	return indexOfColumn(text, limit + 1) < text.length
		? `${text.slice(0, indexOfColumn(text, limit))}…`
		: text;
}

/** The document's lines, each with its newline; a final newline does not start another line. */
export function sourceLines(source: string): string[] {
	let lines: string[] = [];
	let from = 0;
	while (from < source.length) {
		let at = source.indexOf("\n", from);
		let end = at < 0 ? source.length : at + 1;
		lines.push(source.slice(from, end));
		from = end;
	}
	return lines;
}

function flatten(node: RootContent | Heading): string {
	if ("value" in node && typeof node.value === "string") return node.value;
	if ("children" in node) {
		return (node.children as RootContent[]).map(flatten).join("");
	}
	return "";
}

let latest: { source: string; parts: Structure[] } | undefined;

/** The top-level blocks of `source`; the last one is kept, as a document is read in parts. */
function structure(source: string): Structure[] {
	if (latest?.source === source) return latest.parts;
	let parts = parse(source).children.map((node): Structure => {
		let start = node.position?.start.line ?? 1;
		let end = node.position?.end.line ?? start;
		if (node.type !== "heading") return { start, end };
		return { start, end, heading: { depth: node.depth, title: oneLine(flatten(node), 100) } };
	});
	latest = { source, parts };
	return parts;
}

type OutlineEntry = { line: number; depth: number; title: string };

const entry = (item: OutlineEntry) => `L${item.line} ${"#".repeat(item.depth)} ${item.title}`;
const moreHeadings = (count: number) =>
	`(${count} more headings are not listed: deeper levels or later lines.)`;

/** Shallow headings first, in document order within a level, as many as fit. */
function outline(parts: Structure[]): string[] {
	let headings = parts.flatMap(part => part.heading ? [{ line: part.start, ...part.heading }] : []);
	let all = headings.reduce((sum, item) => sum + size(entry(item)) + 1, 0);
	let used = all > OUTLINE_BYTES ? size(moreHeadings(headings.length)) + 1 : 0;
	let chosen = new Set<OutlineEntry>();
	for (let item of headings.toSorted((a, b) => a.depth - b.depth || a.line - b.line)) {
		let cost = size(entry(item)) + 1;
		if (used + cost > OUTLINE_BYTES) break;
		used += cost;
		chosen.add(item);
	}
	let lines = headings.filter(item => chosen.has(item)).map(entry);
	let omitted = headings.length - chosen.size;
	return omitted ? [...lines, moreHeadings(omitted)] : lines;
}

/** `notes` as lines within their byte budget, and a last line for the items that did not fit. */
function listing(notes: Notes): string[] {
	let items = notes.items.map(item => oneLine(item));
	let used = size(notes.title) + 1;
	let kept = 0;
	for (let [index, item] of items.entries()) {
		let next = used + size(item) + 1;
		let rest = index + 1 < items.length ? size(notes.rest(items.length - index - 1)) + 1 : 0;
		if (next + rest > notes.bytes) break;
		used = next;
		kept = index + 1;
	}
	let omitted = items.length - kept;
	return [notes.title, ...items.slice(0, kept), ...omitted ? [notes.rest(omitted)] : []];
}

function checkLines(lines: string[], range: ReadRange): void {
	let total = lines.length;
	let offset = range.offset ?? 1;
	if (range.column !== undefined && range.offset === undefined) {
		throw new ReadRangeError("`column` counts characters in a line: pass `offset` with it.");
	}
	if (offset < 1 || (total ? offset > total : offset !== 1)) {
		throw new ReadRangeError(
			`offset ${offset} is outside the document, which has ${total} line${
				total === 1 ? "" : "s"
			}. Read from a line between 1 and ${Math.max(total, 1)}.`,
		);
	}
	let column = range.column ?? 1;
	let length = total ? characters(lines[offset - 1]!) : 1;
	if (column < 1 || column > length) {
		throw new ReadRangeError(
			`column ${column} is outside line ${offset}, which has ${length} character positions `
				+ `(its characters, then its newline). Read from a column between 1 and ${length}.`,
		);
	}
}

/** Refuses a range that names no position in `source`. */
export function checkRange(source: string, range: ReadRange): void {
	checkLines(sourceLines(source), range);
}

export function documentText(input: DocumentText): string {
	let lines = sourceLines(input.source);
	let total = lines.length;
	let range = input.range ?? {};
	checkLines(lines, range);
	let paged = range.offset !== undefined || range.limit !== undefined;
	let offset = range.offset ?? 1;
	let column = range.column ?? 1;
	let requested = range.limit === undefined ? total : Math.min(total, offset + range.limit - 1);
	let lengths = (line: number) => characters(lines[line - 1]!);

	let parts: Structure[] | undefined;
	let structured = () => parts ??= structure(input.source);
	let blockLines = new Map<number, string[]>();
	for (let block of total ? input.blocks ?? [] : []) {
		let part = structured()[block.index];
		if (!part) continue;
		let line = `${block.index} ${block.type} L${part.start}-${part.end} ${block.digest}`;
		blockLines.set(part.start, [...blockLines.get(part.start) ?? [], line]);
	}
	let listedBytes = (items: string[]) => items.reduce((sum, item) => sum + size(item) + 1, 0);

	let noted = offset === 1 && column === 1
		? (input.notes ?? []).flatMap((notes, index) => [...index ? [""] : [], ...listing(notes)])
		: [];
	let blocks = input.blocks ? `, ${input.blocks.length} blocks` : "";

	let render = (window: Window): string => {
		let out = input.fields.map(([name, value]) => `${name}: ${oneLine(value, FIELD_CHARS)}`);
		out.push(`size: ${characters(input.source)} characters, ${total} lines${blocks}`);
		out.push(
			total === 0
				? "lines: none, the document is empty"
				: window.first === 1 && window.from === 1 && !window.more
				? `lines: all ${total}`
				: `lines: ${window.first}-${window.last} of ${total}`,
		);
		if (window.from > 1) {
			out.push(
				`starts mid-line: line ${window.first} from character ${window.from} of ${
					lengths(window.first)
				}`,
			);
		}
		if (window.cut) {
			out.push(
				`ends mid-line: line ${window.last} after character ${window.cut - 1} of ${
					lengths(window.last)
				}`,
			);
		}
		if (window.asked) {
			out.push(
				`limit: asked for ${window.asked} lines from line ${offset}, but one result holds at most `
					+ `${READ_BYTES} bytes, so this one stops at line ${window.last}${
						window.cut ? ", part way through it" : ""
					}. A limit is a most, not a promise.`,
			);
		}
		if (window.more) {
			let at = window.cut
				? { offset: window.last, column: window.cut }
				: { offset: window.last + 1 };
			out.push(
				`next: ${input.next(at)}`,
				window.outline
					? `This document is larger than one result holds (${READ_BYTES} bytes), so this is `
						+ "its outline and first part. Read the rest with the next call, or jump to a line "
						+ "from the outline."
					: `More follows: each call returns at most ${READ_BYTES} bytes.`,
			);
		}
		if (window.outline?.length) out.push("", "Outline (line, heading):", ...window.outline);
		if (noted.length) out.push("", ...noted);
		if (window.listed.length) {
			let from = window.from > 1 ? window.first + 1 : window.first;
			out.push(
				"",
				`Blocks starting on lines ${from}-${window.last} (index type lines digest):`,
				...window.listed,
			);
		}
		out.push(
			"",
			total === 0
				? "--- source (empty) ---"
				: `--- source lines ${window.first}-${window.last} of ${total} ---`,
		);
		return `${out.join("\n")}\n${window.text}`;
	};

	let take = (room: number, outlined?: string[]): Window => {
		let pieces: string[] = [];
		let listed: string[] = [];
		let used = 0;
		let line = offset;
		let from = column;
		let cut: number | undefined;
		while (line <= requested) {
			let unit = lines[line - 1]!;
			let rest = from === 1 ? unit : unit.slice(indexOfColumn(unit, from));
			let starting = from === 1 ? blockLines.get(line) ?? [] : [];
			let cost = size(rest) + listedBytes(starting);
			if (used + cost <= room) {
				pieces.push(rest);
				listed.push(...starting);
				used += cost;
				line++;
				from = 1;
				continue;
			}
			if (!pieces.length) {
				let piece = prefix(rest, Math.max(room - listedBytes(starting), 4));
				pieces.push(piece);
				listed.push(...starting);
				cut = from + characters(piece);
			}
			break;
		}
		let last = cut ? line : line - 1;
		let more = cut !== undefined || line <= total;
		let short = range.limit !== undefined && more && (cut !== undefined || last < requested);
		return {
			first: offset,
			from: column,
			last,
			cut,
			more,
			asked: short ? range.limit : undefined,
			text: pieces.join(""),
			listed,
			outline: outlined,
		};
	};

	let source = 0;
	for (let line = offset; line <= requested; line++) source += size(lines[line - 1]!);
	if (source <= READ_BYTES) {
		let everything = render(take(Infinity));
		if (size(everything) <= READ_BYTES) return everything;
	}

	let outlined = paged || !total ? undefined : outline(structured());
	let longest = 1;
	for (let line = 1; line <= total; line++) longest = Math.max(longest, lengths(line));
	let worst = render({
		first: offset,
		from: column,
		last: total,
		cut: longest + 1,
		more: true,
		asked: range.limit,
		text: "",
		listed: blockLines.size ? [""] : [],
		outline: outlined,
	});
	let room = READ_BYTES - size(worst);
	for (;;) {
		let text = render(take(room, outlined));
		let excess = size(text) - READ_BYTES;
		if (excess <= 0 || room <= 4) return text;
		room -= excess;
	}
}
