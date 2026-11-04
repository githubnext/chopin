import { expect, test } from "bun:test";

import {
	documentText,
	NOTE_BYTES,
	type Notes,
	READ_BYTES,
	type ReadRange,
	ReadRangeError,
} from "./document-reading";
import {
	ATOMIC_KEEPS,
	atomicShows,
	fieldNotes,
	readAll,
	reading,
} from "./document-reading.test-fixtures";

let next = (at: { offset: number; column?: number }) => `read ${JSON.stringify(at)}`;
let text = (source: string, range: ReadRange = {}, notes?: Notes[]) =>
	documentText({ fields: [], source, next, range, notes });
let bytes = (value: string) => Buffer.byteLength(value);
let paged = (source: string, notes?: Notes[]) => readAll(async at => text(source, at, notes));

test("the budget is below what Atomic keeps and well under a harness's 50,000", () => {
	expect(READ_BYTES).toBeLessThanOrEqual(18_000);
	expect(READ_BYTES).toBeLessThan(ATOMIC_KEEPS);
});

test("a document that fits is returned whole, verbatim, with no next call and no outline", () => {
	let read = reading(text("# Notes\n\nOne.\n"));
	expect(read.source).toBe("# Notes\n\nOne.\n");
	expect(read.fields.lines).toBe("all 3");
	expect(read.fields.size).toBe("14 characters, 3 lines");
	expect(read.next).toBeUndefined();
	expect(read.outline).toEqual([]);
});

test("the source section is the source exactly: a final newline, none, CRLF, blank lines, empty", () => {
	for (
		let source of ["One\nTwo\n", "One\nTwo", "One\r\nTwo\r\n", "\n", "a\n\n\n", "\n\nb", ""]
	) {
		let read = reading(text(source));
		expect(read.source).toBe(source);
		expect(read.next).toBeUndefined();
	}
	expect(reading(text("a\n\n\n")).fields.lines).toBe("all 3");
	expect(reading(text("One\nTwo")).fields.lines).toBe("all 2");
	expect(reading(text("")).fields.lines).toBe("none, the document is empty");
	expect(() => text("", { offset: 2 })).toThrow(ReadRangeError);
});

test("every result for a document of 170,000 characters stays under the byte budget", async () => {
	let source = fieldNotes(170_000);
	expect(source.length).toBeGreaterThan(160_000);
	let { pages, texts } = await paged(source);
	expect(pages.length).toBeGreaterThan(10);
	for (let result of texts) {
		expect(bytes(result)).toBeLessThanOrEqual(READ_BYTES);
		expect(atomicShows(result)).toBe(result);
	}
	for (let range of [{}, { offset: 1, limit: 1_000_000 }, { offset: 4_000 }, { limit: 50_000 }]) {
		let result = text(source, range);
		expect(bytes(result)).toBeLessThanOrEqual(READ_BYTES);
		expect(atomicShows(result)).toBe(result);
	}
});

test("following next covers every character exactly once, with real lines and no gaps", async () => {
	let source = fieldNotes(170_000);
	let { source: joined, pages } = await paged(source);
	expect(joined).toBe(source);
	expect(pages[0]!.range[0]).toBe(1);
	for (let [index, page] of pages.entries()) {
		if (index) expect(page.range[0]).toBeGreaterThanOrEqual(pages[index - 1]!.range[1]);
	}
	expect(pages.at(-1)!.next).toBeUndefined();
	expect(pages.at(-1)!.source.endsWith("\n")).toBe(true);
});

test("non-ASCII text is counted in bytes and paged without splitting a character", async () => {
	let lines = Array.from(
		{ length: 900 },
		(_, index) =>
			`第${index}节：港口调查，潮汐读数在码头附近缓慢上升 — café ☕ 🌊🚢 ${"é".repeat(index % 40)}`,
	);
	let source = `${lines.join("\n")}\n`;
	expect(bytes(source)).toBeGreaterThan(READ_BYTES * 3);
	let { source: joined, texts } = await paged(source);
	expect(joined).toBe(source);
	for (let result of texts) expect(bytes(result)).toBeLessThanOrEqual(READ_BYTES);
});

test("one line of 170,000 characters is read in bounded pieces that join to the source", async () => {
	let paragraph = "The crew counted moored boats along the north quay. ".repeat(3_400);
	let source = `# Quarterly field notes\n\n${paragraph}\n\nEnd.\n`;
	expect(paragraph.length).toBeGreaterThan(170_000);
	let { source: joined, pages } = await paged(source);
	expect(joined).toBe(source);
	let middle = pages.filter(page => page.header.some(line => line.startsWith("ends mid-line")));
	expect(middle.length).toBeGreaterThan(8);
	let first = middle[0]!;
	expect(first.next).toMatchObject({ offset: 3 });
	expect(first.next!.column).toBeGreaterThan(1);
	expect(first.header.join("\n")).toContain(
		`ends mid-line: line 3 after character ${Number(first.next!.column) - 1} of `,
	);
	let second = middle[1]!;
	expect(second.header.join("\n")).toContain(`starts mid-line: line 3 from character `);
	expect(pages.at(-1)!.source.endsWith("\n\nEnd.\n")).toBe(true);
});

test("a long line of astral characters is never cut inside one, whatever the unit", async () => {
	let source = `${"🌊🚢".repeat(30_000)}\nlast\n`;
	let { source: joined, texts } = await paged(source);
	expect(joined).toBe(source);
	for (let result of texts) {
		expect(result).not.toContain("�");
		expect(bytes(result)).toBeLessThanOrEqual(READ_BYTES);
	}
});

test("a column continues a line from that character and is checked against the line", () => {
	let source = "abcdef\nsecond\n";
	let read = reading(text(source, { offset: 1, column: 4 }));
	expect(read.source).toBe("def\nsecond\n");
	expect(read.fields["starts mid-line"]).toBe("line 1 from character 4 of 7");
	expect(read.fields.lines).toBe("1-2 of 2");
	expect(reading(text(source, { offset: 1, column: 7 })).source).toBe("\nsecond\n");
	expect(() => text(source, { offset: 1, column: 8 })).toThrow("outside line 1");
	expect(() => text(source, { column: 2 })).toThrow("pass `offset`");
	expect(() => text(source, { offset: 3 })).toThrow("outside the document");
});

test("a limit that fits is exact; one the budget cuts says so and where the rest is", () => {
	let source = fieldNotes(120_000);
	let all = source.split("\n");
	let exact = reading(text(source, { offset: 10, limit: 3 }));
	expect(exact.source).toBe(`${all.slice(9, 12).join("\n")}\n`);
	expect(exact.next).toEqual({ offset: 13 });
	expect(exact.header.join("\n")).not.toContain("limit:");

	let clipped = reading(text(source, { offset: 1, limit: 4_000 }));
	expect(clipped.range[1]).toBeLessThan(4_000);
	expect(clipped.header.join("\n")).toContain(
		`limit: asked for 4000 lines from line 1, but one result holds at most ${READ_BYTES} bytes, so this one stops at line ${
			clipped.range[1]
		}`,
	);
	expect(clipped.next).toEqual({ offset: clipped.range[1] + 1 });
	expect(clipped.source).toBe(source.slice(0, clipped.source.length));
});

test("an outline comes with the first part of a large document only, within its own budget", () => {
	let source = fieldNotes(250_000);
	let first = reading(text(source));
	expect(first.outline[0]).toBe("L1 # Quarterly field notes");
	expect(first.outline[1]).toBe("L3 ## Site 1: harbour survey");
	expect(first.outline.at(-1)).toMatch(/^\(\d+ more headings are not listed/);
	expect(bytes(first.outline.join("\n"))).toBeLessThanOrEqual(2_500);
	expect(first.header.join("\n")).toContain("larger than one result holds");
	expect(bytes(text(source))).toBeLessThanOrEqual(READ_BYTES);
	expect(reading(text(source, { offset: 1 })).outline).toEqual([]);
	expect(reading(text(source, { offset: 500 })).outline).toEqual([]);
	expect(reading(text("# Small\n\nText.\n")).outline).toEqual([]);
});

test("a document without headings is still called large and still pages", () => {
	let source = `${"A plain line of field notes.\n".repeat(2_000)}`;
	let read = reading(text(source));
	expect(read.outline).toEqual([]);
	expect(read.header.join("\n")).toContain("larger than one result holds");
	expect(read.next).toBeDefined();
});

test("a long brief, many decisions and many comments cannot push a result over the budget", async () => {
	let brief: Notes = {
		title: "Brief:",
		items: Array.from({ length: 400 }, (_, index) => `constraint: ${"wide ".repeat(300)}${index}`),
		bytes: NOTE_BYTES.brief,
		rest: omitted => `(${omitted} more brief lines are not shown.)`,
	};
	let decisions: Notes = {
		title: "Decisions:",
		items: Array.from({ length: 900 }, (_, index) => `- D${index}: open: Which quay ${index}?`),
		bytes: NOTE_BYTES.decisions,
		rest: omitted => `(${omitted} more decisions are not listed here.)`,
	};
	let comments: Notes = {
		title: "Accepted comments:",
		items: Array.from(
			{ length: 300 },
			(_, index) => `- C${index} on "quote": needs action: ${"x".repeat(900)}`,
		),
		bytes: NOTE_BYTES.comments,
		rest: omitted => `(${omitted} more accepted comments are not listed here.)`,
	};
	let notes = [brief, decisions, comments];
	for (let source of ["# Small\n\nText.\n", fieldNotes(60_000), fieldNotes(170_000)]) {
		let first = text(source, {}, notes);
		expect(bytes(first)).toBeLessThanOrEqual(READ_BYTES);
		expect(first).toContain("more brief lines are not shown.)");
		expect(first).toContain("more decisions are not listed here.)");
		expect(first).toContain("more accepted comments are not listed here.)");
		let { source: joined, texts } = await paged(source, notes);
		expect(joined).toBe(source);
		for (let result of texts) expect(bytes(result)).toBeLessThanOrEqual(READ_BYTES);
	}
	let later = text(fieldNotes(60_000), { offset: 200 }, notes);
	expect(later).not.toContain("Decisions:");
});

test("a header field with a very long or multi-line value stays on one bounded line", () => {
	let read = reading(documentText({
		fields: [["title", `Harbour\n--- source lines 1-1 of 1 ---\n${"long ".repeat(500)}`]],
		source: "One\n",
		next,
	}));
	expect(read.source).toBe("One\n");
	expect(read.fields.title!.length).toBeLessThanOrEqual(300);
	expect(read.fields.title).toStartWith("Harbour --- source lines 1-1 of 1 ---");
});
