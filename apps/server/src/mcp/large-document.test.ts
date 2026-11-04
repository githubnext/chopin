import { describe, expect, it } from "bun:test";

import { handler, TOOLS } from "../mcp";
import { READ_BYTES } from "../document-reading";
import {
	ATOMIC_KEEPS,
	atomicShows,
	fieldNotes,
	readAll,
	reading,
} from "../document-reading.test-fixtures";

import type { LinkedDocument } from "../mcp";

let source = fieldNotes(170_000);
let document: LinkedDocument = {
	id: "f401c8d6-3717-4f1d-8473-cfdd0af894e4",
	title: "Quarterly field notes",
	source,
	revision: 12,
	url: "/documents/githubnext/chopin/quarterly-field-notes",
};

function readerOf(shown: () => LinkedDocument) {
	return handler({
		caller: () => "octocat",
		documents: {
			async list() {
				return [];
			},
			async read(_caller, id) {
				return id === shown().id ? shown() : undefined;
			},
		},
	});
}

async function callOn(
	mcp: ReturnType<typeof readerOf>,
	id: string,
	arguments_: Record<string, unknown>,
) {
	let response = await mcp(
		new Request("https://chopin.test/mcp", {
			method: "POST",
			headers: { authorization: "Bearer allowed", "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "read_document", arguments: { id, ...arguments_ } },
			}),
		}),
	);
	return await response.json() as {
		result?: { content: Array<{ text: string }>; structuredContent: unknown };
		error?: { code: number; message: string };
	};
}

let call = (arguments_: Record<string, unknown>) =>
	callOn(readerOf(() => document), document.id, arguments_);

/** The text a model reads, the same way a harness that cuts long text would show it. */
let shown = async (arguments_: Record<string, unknown>) =>
	(await call(arguments_)).result!.content[0]!.text;

describe("read_document on a document of about 170,000 characters", () => {
	it("returns the outline and first part with how to continue, never the whole source", async () => {
		let text = await shown({});
		let read = reading(text);
		expect(source.length).toBeGreaterThan(160_000);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(READ_BYTES);
		expect(READ_BYTES).toBeLessThan(ATOMIC_KEEPS);
		expect(atomicShows(text)).toBe(text);
		expect(text.split("\n").length).toBeGreaterThan(100);
		expect(read.fields).toMatchObject({
			id: document.id,
			title: "Quarterly field notes",
			revision: "12",
			url: document.url,
		});
		expect(read.next).toEqual({ id: document.id, offset: read.range[1] + 1 });
		expect(read.outline.slice(0, 3)).toEqual([
			"L1 # Quarterly field notes",
			"L3 ## Site 1: harbour survey",
			"L18 ## Site 2: harbour survey",
		]);
		expect(source.startsWith(read.source)).toBe(true);
	});

	it("covers every character exactly once when a reader follows next, each result in budget", async () => {
		let { source: joined, pages } = await readAll(range => shown(range));
		expect(pages.length).toBeGreaterThan(10);
		expect(joined).toBe(source);
		for (let page of pages.slice(1)) expect(page.outline).toEqual([]);
		expect(pages.at(-1)!.source.endsWith("\n")).toBe(true);
	});

	it("returns an exact slice and the total line count for offset and limit", async () => {
		let all = source.split("\n");
		let read = reading(await shown({ offset: 1_001, limit: 7 }));
		expect(read.source).toBe(`${all.slice(1_000, 1_007).join("\n")}\n`);
		expect(read.total).toBe(all.length - 1);
		expect(read.fields.lines).toBe(`1001-1007 of ${all.length - 1}`);
		expect(read.next).toEqual({ id: document.id, offset: 1_008 });
	});

	it("keeps a limit a maximum: a result the budget cuts says where it stopped", async () => {
		let text = await shown({ offset: 1, limit: 3_000 });
		let read = reading(text);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(READ_BYTES);
		expect(read.range[1]).toBeLessThan(3_000);
		expect(read.fields.limit).toContain("asked for 3000 lines from line 1");
		expect(read.next).toEqual({ id: document.id, offset: read.range[1] + 1 });
	});

	it("keeps structuredContent the whole document whatever slice was asked for", async () => {
		for (let range of [{}, { offset: 5_000 }, { offset: 3, limit: 2 }]) {
			expect((await call(range)).result!.structuredContent).toEqual(document);
		}
	});

	it("refuses an offset or column outside the document and non-integer paging", async () => {
		let total = source.split("\n").length - 1;
		expect((await call({ offset: total + 1 })).error?.code).toBe(-32602);
		expect((await call({ offset: total })).result?.content[0]?.text).toContain(
			`lines: ${total}-${total} of ${total}`,
		);
		expect((await call({ offset: 1, column: 9_999 })).error?.message).toContain("outside line 1");
		expect((await call({ column: 2 })).error?.message).toContain("pass `offset`");
		for (let bad of [{ offset: 0 }, { limit: 1.5 }, { offset: "2" }, { column: 0 }]) {
			expect((await call(bad)).error?.code).toBe(-32602);
		}
	});

	it("describes the byte budget, the continuation and the column in the tool", () => {
		let tool = TOOLS.find(item => item.name === "read_document")!;
		expect(tool.description).toContain("16,000 bytes");
		expect(tool.description).toContain("`next:`");
		expect(tool.description).toContain("`column`");
		expect(tool.inputSchema).toMatchObject({
			properties: {
				offset: { type: "integer", minimum: 1 },
				limit: { type: "integer", minimum: 1 },
				column: { type: "integer", minimum: 1 },
			},
		});
		expect(tool.description).not.toContain("30,000");
	});
});

describe("read_document on other shapes of document", () => {
	let id = document.id;
	let readerFor = (text: string, extra: Partial<LinkedDocument> = {}) =>
		readerOf(() => ({ ...document, source: text, ...extra }));

	it("returns a small document whole and verbatim, terminal newline included", async () => {
		for (let text of ["# Test\n\nSome text.\n", "# Test\n\nSome text.", "a\r\nb\r\n", "", "\n"]) {
			let small = { ...document, source: text };
			let response = await callOn(readerFor(text), id, {});
			let result = response.result!;
			let read = reading(result.content[0]!.text);
			expect(read.source).toBe(text);
			expect(read.next).toBeUndefined();
			expect(result.structuredContent).toEqual(small);
		}
		let whole = await callOn(readerFor("# Notes\n\nOne.\n\nTwo.\n"), id, {});
		expect(whole.result!.content[0]!.text).toContain("lines: all 5");
		expect(whole.result!.content[0]!.text).not.toContain("next:");
	});

	it("pages accented, CJK and emoji text by bytes and joins back to the source", async () => {
		let lines = Array.from(
			{ length: 700 },
			(_, index) => `第${index}节：港口调查，潮汐读数 — café ☕ 🌊🚢 ${"é".repeat(index % 30)}`,
		);
		let text = `${lines.join("\n")}\n`;
		let mcp = readerFor(text);
		let { source: joined, pages } = await readAll(async range =>
			(await callOn(mcp, id, range)).result!.content[0]!.text
		);
		expect(Buffer.byteLength(text)).toBeGreaterThan(READ_BYTES * 3);
		expect(pages.length).toBeGreaterThan(3);
		expect(joined).toBe(text);
	});

	it("reads one huge line in bounded pieces by line and column", async () => {
		let paragraph = "The crew counted moored boats along the north quay. ".repeat(3_400);
		let text = `# Quarterly field notes\n\n${paragraph}\n\nEnd.\n`;
		let mcp = readerFor(text);
		let { source: joined, pages, texts } = await readAll(async range =>
			(await callOn(mcp, id, range)).result!.content[0]!.text
		);
		expect(joined).toBe(text);
		expect(pages.some(page => page.next?.column !== undefined)).toBe(true);
		expect(texts.every(item => Buffer.byteLength(item) <= READ_BYTES)).toBe(true);
	});

	it("trims a long brief inside the budget and points at structuredContent for the rest", async () => {
		let brief = {
			goal: "Plan the autumn survey of the harbour.",
			constraints: Array.from(
				{ length: 300 },
				(_, index) => `${"Keep boats clear. ".repeat(40)}${index}`,
			),
			settledDecisions: Array.from({ length: 50 }, (_, index) => `Start from quay ${index}.`),
			openQuestions: [],
			repositoryFindings: ["Nothing recorded yet."],
		};
		let big = { source: fieldNotes(60_000), brief };
		let mcp = readerFor(big.source, { brief });
		let response = await callOn(mcp, id, {});
		let text = response.result!.content[0]!.text;
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(READ_BYTES);
		expect(text).toContain("Brief:\ngoal: Plan the autumn survey of the harbour.");
		expect(text).toMatch(
			/\(\d+ more brief lines are not shown; the whole brief is in structuredContent\.brief\.\)/,
		);
		expect((response.result!.structuredContent as LinkedDocument).brief).toEqual(brief);
		let { source: joined } = await readAll(async range =>
			(await callOn(mcp, id, range)).result!.content[0]!.text
		);
		expect(joined).toBe(big.source);
		let small = await callOn(readerFor("# Notes\n", { brief }), id, {});
		expect(Buffer.byteLength(small.result!.content[0]!.text)).toBeLessThanOrEqual(READ_BYTES);
	});
});
