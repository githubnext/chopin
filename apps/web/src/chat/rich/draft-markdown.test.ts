import { describe, expect, it } from "bun:test";

import { parseDraft, serializeDraft } from "./draft-markdown";

import type { ReferenceDraft } from "../references";
import type { Block } from "./draft-markdown";

function roundTrip(markdown: string, references: ReferenceDraft[] = []) {
	return serializeDraft(parseDraft(markdown, references));
}

describe("the rich draft's Markdown", () => {
	it("writes back every format it draws exactly as it was sent", () => {
		for (
			let markdown of [
				"",
				"plain words",
				"**bold** and _italic_ and ~~struck~~",
				"`code` in a line",
				"a [link](https://example.com) here",
				"**_both_** at once",
				"intra*word*emphasis",
				"- one\n- two",
				"1. first\n2. second",
				"3. third\n4. fourth",
				"```\nlet x = 1;\nlet y = 2;\n```",
				"```ts\nlet x = 1;\n```",
				"intro\n- one\n- two\n\nafter",
				"a\n\nb",
				"a\n\n\n\nb",
				"line one\nline two",
				"trailing\n",
				"\nleading",
				"- one\n\n\nafter two blanks",
				"- one\n```\ncode\n```",
			]
		) {
			expect(roundTrip(markdown).markdown).toBe(markdown);
		}
	});

	it("draws each format as formatting, not as its marks", () => {
		let [paragraph] = parseDraft("**bold** _it_ ~~gone~~ `x` [l](u)") as [
			Extract<Block, { type: "paragraph" }>,
		];
		expect(paragraph.leaves.map(leaf => leaf.type === "break" ? "\n" : [leaf.text, leaf.marks]))
			.toEqual([
				["bold", { bold: true }],
				[" ", {}],
				["it", { italic: true }],
				[" ", {}],
				["gone", { strike: true }],
				[" ", {}],
				["x", { code: true }],
				[" ", {}],
				["l", {}],
			]);
		expect(parseDraft("- a\n- b")).toEqual([
			{
				type: "list",
				ordered: false,
				start: 1,
				items: [
					{ leaves: [{ type: "text", text: "a", marks: {} }] },
					{ leaves: [{ type: "text", text: "b", marks: {} }] },
				],
			},
		]);
		expect(parseDraft("```\nx\n```")).toEqual([{ type: "code", lang: "", text: "x" }]);
	});

	it("keeps as plain lines what the draft would write differently, so nothing sent changes", () => {
		for (
			let markdown of [
				"*star emphasis*",
				"__strong underscores__",
				"> a quote",
				"# a heading",
				"* star bullet",
				"1) paren list",
				"    indented code",
				"| a | b |\n| - | - |\n| 1 | 2 |",
				"a \\* escaped star",
				"<https://example.com>",
				"![image](x.png)",
				"- [ ] a task",
				"~single tilde~",
				"```\nunclosed fence",
			]
		) {
			expect(roundTrip(markdown).markdown).toBe(markdown);
		}
		let [quote] = parseDraft("> **a** quote");
		expect(quote).toEqual({
			type: "paragraph",
			leaves: [{ type: "text", text: "> **a** quote", marks: {} }],
		});
	});

	it("writes formatting the editor made as Markdown that reads back the same", () => {
		let blocks: Block[] = [
			{
				type: "paragraph",
				leaves: [
					{ type: "text", text: "say ", marks: {} },
					{ type: "text", text: "bold ", marks: { bold: true } },
					{ type: "text", text: "and both", marks: { bold: true, italic: true } },
					{ type: "text", text: " now", marks: {} },
				],
			},
			{
				type: "paragraph",
				leaves: [
					{ type: "text", text: "mid", marks: {} },
					{ type: "text", text: "word", marks: { italic: true } },
					{ type: "text", text: "s", marks: {} },
				],
			},
			{ type: "list", ordered: true, start: 1, items: [{ leaves: [] }, { leaves: [] }] },
			{ type: "paragraph", leaves: [{ type: "text", text: "after", marks: {} }] },
		];
		let { markdown } = serializeDraft(blocks);
		expect(markdown).toBe("say **bold _and both_** now\nmid*word*s\n1. \n2. \n\nafter");
		expect(roundTrip(markdown).markdown).toBe(markdown);
	});

	it("keeps references and mentions as they were, and says where each is", () => {
		let text = "Ask @mona about @Release plan and #Roadmap **now**";
		let references: ReferenceDraft[] = [
			{ kind: "heading", anchor: "release-plan", start: 16, end: 29, token: "@Release plan" },
			{ kind: "document", channelId: "c1", start: 34, end: 42, token: "#Roadmap" },
		];
		let result = roundTrip(text, references);
		expect(result.markdown).toBe(text);
		expect(result.references).toEqual(references);
		// Marks inside a reference's words are never read as Markdown.
		let starred: ReferenceDraft[] = [
			{ kind: "heading", anchor: "x", start: 0, end: 9, token: "@*a* b*c*" },
		];
		let [paragraph] = parseDraft("@*a* b*c* end", starred);
		expect(paragraph).toEqual({
			type: "paragraph",
			leaves: [
				{
					type: "reference",
					text: "@*a* b*c*",
					reference: { kind: "heading", anchor: "x", token: "@*a* b*c*" },
					marks: {},
				},
				{ type: "text", text: " end", marks: {} },
			],
		});
	});

	it("says where each keyed piece of text is in the Markdown", () => {
		let { slots } = serializeDraft([
			{
				type: "paragraph",
				key: "p",
				leaves: [
					{ type: "text", text: "a ", marks: {}, key: "t1" },
					{ type: "text", text: "b", marks: { bold: true }, key: "t2" },
				],
			},
			{ type: "list", ordered: false, start: 1, key: "l", items: [{ key: "i", leaves: [] }] },
		]);
		expect(slots).toEqual([
			{ kind: "element", key: "p", start: 0, end: 7, empty: false },
			{ kind: "leaf", key: "t1", segments: [{ at: 0, md: 0, length: 2 }], token: false },
			{ kind: "leaf", key: "t2", segments: [{ at: 0, md: 4, length: 1 }], token: false },
			{ kind: "element", key: "l", start: 8, end: 10, empty: false },
			{ kind: "element", key: "i", start: 10, end: 10, empty: true },
		]);
	});
});
