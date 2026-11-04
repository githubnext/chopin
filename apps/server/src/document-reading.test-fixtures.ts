import { READ_BYTES } from "./document-reading";

export type ReadBlock = { index: number; type: string; lines: [number, number]; digest: string };

export type Reading = {
	fields: Record<string, string>;
	/** The header lines, up to the first blank one. */
	header: string[];
	outline: string[];
	/** Every line between the header and the source marker: outline, lists and block listing. */
	notes: string[];
	blocks: ReadBlock[];
	/** The source section, verbatim: everything after the marker line. */
	source: string;
	/** The first and last line the result names, and the document's line count. */
	range: [number, number];
	total: number;
	/** The arguments `next:` says to call with, when it does. */
	next?: Record<string, unknown>;
};

/** A document of about `characters`: headed sections of short and long lines, lists and a table. */
export function fieldNotes(characters = 170_000): string {
	let sections: string[] = ["# Quarterly field notes", ""];
	let size = sections.join("\n").length;
	for (let site = 1; size < characters; site++) {
		let section = [
			`## Site ${site}: harbour survey`,
			"",
			`Observers walked the north quay on day ${site} and counted ${site * 7} moored boats.`,
			"",
			`### Tide readings ${site}`,
			"",
			`- Morning reading ${site}.1 was steady across the basin.`,
			`- Evening reading ${site}.2 rose slowly toward the breakwater.`,
			"",
			"| Reading | Level |",
			"| --- | --- |",
			`| ${site}.1 | ${site % 5} |`,
			"",
			`The notes for site ${site} repeat what the crew saw while they waited for the tide to turn, `
			+ "in enough words to make this paragraph a line of its own that is longer than most.",
			"",
		].join("\n");
		sections.push(section);
		size += section.length + 1;
	}
	return `${sections.join("\n")}\n`;
}

/** Atomic's MCP adapter keeps the head and tail of model-facing text over this many bytes. */
export const ATOMIC_KEEPS = 20 * 1024;

/** What a harness that cuts the middle of long text, as Atomic's MCP adapter does, shows of `text`. */
export function atomicShows(text: string): string {
	let bytes = Buffer.from(text);
	if (bytes.length <= ATOMIC_KEEPS) return text;
	let head = bytes.subarray(0, ATOMIC_KEEPS / 2).toString();
	let tail = bytes.subarray(bytes.length - ATOMIC_KEEPS / 2).toString();
	return `${head}…truncated…${tail}`;
}

export function reading(text: string): Reading {
	let at = text.indexOf("\n--- source ");
	if (at < 0) throw new Error("no source marker");
	let head = text.slice(0, at).split("\n");
	let rest = text.slice(at + 1);
	let marker = rest.slice(0, rest.indexOf("\n"));
	let blank = head.indexOf("");
	let header = blank < 0 ? head : head.slice(0, blank);
	let fields: Record<string, string> = {};
	for (let line of header) {
		let colon = line.indexOf(": ");
		if (colon > 0 && !(line.slice(0, colon) in fields)) {
			fields[line.slice(0, colon)] = line.slice(colon + 2);
		}
	}
	let section = (title: RegExp) => {
		let from = head.findIndex(line => title.test(line));
		if (from < 0) return [];
		let to = head.indexOf("", from);
		return head.slice(from + 1, to < 0 ? head.length : to);
	};
	let range = /^--- source lines (\d+)-(\d+) of (\d+) ---$/.exec(marker);
	let next = fields.next === undefined
		? undefined
		: JSON.parse(fields.next.slice(fields.next.indexOf(" ") + 1)) as Record<string, unknown>;
	return {
		fields,
		header,
		outline: section(/^Outline \(line, heading\):$/),
		notes: head.slice(blank < 0 ? head.length : blank + 1),
		blocks: section(/^Blocks starting on lines /).map(line => {
			let [index, type, span, digest] = line.split(" ") as [string, string, string, string];
			let [start, end] = span.slice(1).split("-").map(Number) as [number, number];
			return { index: Number(index), type, lines: [start, end], digest };
		}),
		source: rest.slice(rest.indexOf("\n") + 1),
		range: range ? [Number(range[1]), Number(range[2])] : [0, 0],
		total: range ? Number(range[3]) : 0,
		next,
	};
}

/**
 * Follow `next:` through `read` until a result has none. Every result is checked against the
 * budget and against what Atomic would keep of it; the sources, joined, are the document.
 */
export async function readAll(
	read: (arguments_: { offset?: number; column?: number }) => Promise<string>,
	budget = READ_BYTES,
): Promise<{ source: string; pages: Reading[]; texts: string[] }> {
	let pages: Reading[] = [];
	let texts: string[] = [];
	let at: { offset?: number; column?: number } = {};
	for (let calls = 0; calls < 2_000; calls++) {
		let text = await read(at);
		if (Buffer.byteLength(text) > budget) {
			throw new Error(`a result carried ${Buffer.byteLength(text)} bytes`);
		}
		if (atomicShows(text) !== text) throw new Error("a result would be cut by the harness");
		texts.push(text);
		let page = reading(text);
		pages.push(page);
		if (!page.next) return { source: pages.map(item => item.source).join(""), pages, texts };
		at = { offset: page.next.offset as number, column: page.next.column as number | undefined };
	}
	throw new Error("next: never ended");
}
