import { describe, expect, it } from "bun:test";

import * as limits from "./limits";
import { parse } from "./parse";
import { serialize } from "./serialize";
import { assertIntroducedUrls, PlanValidationError, validate } from "./validate";

import type { PhrasingContent, RootContent } from "mdast";

const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const ID2 = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const ID3 = "01K0N4W3B7P27CBAEC7A8C8WEA";

function codes(source: string): string[] {
	let result = validate(parse(source));
	return result.ok ? [] : result.issues.map(issue => issue.code);
}

function linkTo(url: string): PhrasingContent {
	return { type: "link", url, children: [{ type: "text", value: "x" }] };
}

/** Issue codes for URLs that `after` brings in beyond `before`. */
function introduced(before: RootContent[], after: Array<RootContent | PhrasingContent>): string[] {
	let wrap = (nodes: Array<RootContent | PhrasingContent>): RootContent[] =>
		nodes.map(node =>
			node.type === "link" || node.type === "image"
				? { type: "paragraph", children: [node] }
				: node as RootContent
		);
	try {
		assertIntroducedUrls(before, wrap(after));
		return [];
	} catch (err) {
		return err instanceof PlanValidationError ? err.issues.map(issue => issue.code) : ["threw"];
	}
}

function accepts(source: string): void {
	let result = validate(parse(source));
	if (!result.ok) {
		throw new Error(
			`expected valid, got: ${result.issues.map(i => `${i.code} @ ${i.path}`).join(", ")}`,
		);
	}
}

/** Canonical output must be a fixed point: serialising it again changes nothing. */
function canonical(source: string): string {
	let once = serialize(parse(source));
	expect(serialize(parse(once))).toBe(once);
	return once;
}

describe("markdown baseline", () => {
	it("round-trips core constructs to canonical form", () => {
		expect(canonical("# Title")).toBe("# Title\n");
		expect(canonical("Some *italic* and **bold**.")).toBe("Some _italic_ and **bold**.\n");
		expect(canonical("~~gone~~")).toBe("~~gone~~\n");
		expect(canonical("`code`")).toBe("`code`\n");
		expect(canonical("* one\n* two")).toBe("- one\n- two\n");
		expect(canonical("> quoted")).toBe("> quoted\n");
		expect(canonical("***")).toBe("---\n");
	});

	it("preserves task lists", () => {
		expect(canonical("- [ ] todo\n- [x] done")).toBe(
			"* [ ] todo\n* [x] done\n".replace(/\*/g, "-"),
		);
	});

	it("preserves tables with alignment", () => {
		let out = canonical("| Name | Status |\n| :--- | -----: |\n| API | Ready |");
		expect(out).toContain("| :--- | -----: |");
		expect(out).toContain("| API  |  Ready |");
	});

	it("preserves fenced code with language", () => {
		expect(canonical("```ts\nlet a = 1;\n```")).toBe("```ts\nlet a = 1;\n```\n");
	});

	it("preserves math", () => {
		expect(canonical("$a + b$")).toBe("$a + b$\n");
		expect(canonical("$$\na + b\n$$")).toBe("$$\na + b\n$$\n");
	});

	it("preserves mermaid as a code fence", () => {
		expect(canonical("```mermaid\ngraph TD;\nA-->B;\n```")).toContain("```mermaid");
	});

	it("preserves footnotes with ULID identifiers", () => {
		let source = `Claim.[^${ID}]\n\n[^${ID}]: Because.\n`;
		accepts(source);
		expect(canonical(source)).toContain(`[^${ID}]`);
	});
});

describe("security boundary", () => {
	it("cannot represent ESM imports or exports", () => {
		// The mdxjs extension is not enabled, so these never become executable
		// nodes — they degrade to inert prose.
		for (let source of ["import x from './y'", "export const a = 1"]) {
			let tree = parse(source);
			expect(tree.children.map(child => child.type)).toEqual(["paragraph"]);
			accepts(source);
		}
	});

	it("rejects raw HTML tags as unknown components", () => {
		// `mdxMd()` disables HTML, so angle brackets are JSX and fall to the allowlist.
		expect(codes("<div>text</div>")).toContain("unknown-component");
		expect(codes("Inline <span>x</span> here.")).toContain("unknown-component");
	});

	it("rejects unknown components", () => {
		expect(codes(`<Chart id="${ID}" />`)).toContain("unknown-component");
	});

	it("rejects JSX fragments", () => {
		expect(codes("<>text</>")).toContain("fragment");
	});

	it("rejects spread and expression attributes", () => {
		expect(codes(`<Callout {...props} />`)).toContain("spread-attribute");
		expect(codes(`<Callout id={x} type="note">hi</Callout>`))
			.toContain("expression-attribute");
	});

	it("rejects active link protocols", () => {
		expect(codes("[x](javascript:alert(1))")).toContain("bad-link-protocol");
		expect(codes("[x](data:text/html;base64,PHA+)")).toContain("bad-link-protocol");
	});

	/**
	 * Built as trees, not parsed: markdown refuses control characters in a
	 * destination, but a Lexical export or an agent's operation does not.
	 */
	it("refuses introduced links that hide a scheme or name another host", () => {
		for (
			let url of [
				"\u0001javascript:alert(1)",
				"java\u0000script:alert(1)",
				"java\u200bscript:alert(1)",
				"https://ex\u200bample.com",
				"\ufeffhttps://example.com",
				"//evil.com",
				"\\\\evil.com",
				"/\\evil.com",
				"docs\\a.md",
			]
		) {
			expect(introduced([], [linkTo(url)])).toContain("bad-link");
		}
		expect(introduced([], [{ type: "image", url: "\u0001https://example.com/x.png", alt: "" }]))
			.toContain("bad-image");
		expect(introduced([], [linkTo("docs/a.md"), linkTo("https://example.com")])).toEqual([]);
	});

	/** Stored before the rule existed: refusing it on every open would lock the document. */
	it("leaves a stored link alone that only the newer URL rules refuse", () => {
		let stored = parse("Read [the notes](docs\\\\notes.md).\n");
		expect((stored.children[0] as { children: Array<{ url?: string }> }).children[1]?.url)
			.toBe("docs\\notes.md");
		expect(validate(stored).ok).toBe(true);
		expect(introduced(stored.children, [...stored.children, linkTo("https://example.com")]))
			.toEqual([]);
		expect(introduced(stored.children, [linkTo("//evil.com")])).toContain("bad-link");
	});

	it("allows https, mailto and repo-relative paths", () => {
		accepts("[x](https://example.com)");
		accepts("[x](mailto:a@b.com)");
		accepts("[x](&plan.mdx)");
		accepts("[x](src/index.ts)");
	});

	it("requires images to be absolute https URLs", () => {
		expect(codes("![a](http://example.com/x.png)")).toContain("bad-image-protocol");
		expect(codes("![a](data:image/png;base64,iVBORw0KGgo=)")).toContain("bad-image-protocol");
		// Unlike a link, a relative image has nothing to resolve against.
		expect(codes("![a](docs/diagram.png)")).toContain("bad-image");
		accepts("![a](https://example.com/x.png)");
	});

	it("rejects frontmatter", () => {
		// Without the frontmatter extension this parses as a thematic break plus
		// text, never as metadata — assert it cannot smuggle a yaml node.
		let tree = parse("---\ntitle: x\n---\n\nbody");
		expect(JSON.stringify(tree)).not.toContain('"yaml"');
	});
});

describe("serialization safety", () => {
	// `mdxMd()` makes every `<` a potential JSX tag, so prose containing angle
	// brackets is only safe because the serializer escapes it. Editor content is
	// built as a tree and written out, so this is the property that guarantees
	// anything we emit can be read back.
	it("escapes angle brackets so emitted prose always re-parses", () => {
		let samples = [
			"x <3 y",
			"<https://example.com>",
			"a < b",
			"<Not Closed",
			"5 > 3 && 2 < 4",
			"use <Callout> here",
		];

		for (let value of samples) {
			let source = serialize({
				type: "root",
				children: [{ type: "paragraph", children: [{ type: "text", value }] }],
			});
			let tree = parse(source);
			let paragraph = tree.children[0];
			expect(paragraph?.type).toBe("paragraph");
			expect(paragraph?.type === "paragraph" && paragraph.children[0]).toMatchObject({
				type: "text",
				value,
			});
		}
	});
});

describe("components", () => {
	it("accepts a questionnaire", () => {
		accepts(
			`<Questionnaire id="${ID}">\n`
				+ `<Question id="${ID2}" header="Rollout" prompt="How?" multiple="false">\n`
				+ `<Option id="${ID3}" label="Canary" />\n`
				+ `</Question>\n`
				+ `</Questionnaire>`,
		);
	});

	it("accepts `expired` and rejects unknown questionnaire statuses", () => {
		let questionnaire = (status: string) =>
			`<Questionnaire id="${ID}" status="${status}" at="2026-09-28T10:30:00.000Z">\n`
			+ `<Question id="${ID2}" header="Rollout" prompt="How?" multiple="false">\n`
			+ `<Option id="${ID3}" label="Canary" />\n`
			+ `</Question>\n`
			+ `</Questionnaire>`;
		accepts(questionnaire("expired"));
		for (let status of ["cancelled", "answered", "Expired"]) {
			expect(codes(questionnaire(status))).toContain("bad-attribute-value");
		}
	});

	it("accepts an accepted comment thread", () => {
		accepts(
			`<Decision id="${ID}" quote="Cached for 60 seconds." by="ana" at="2026-07-28T10:14:00Z">\n`
				+ `<Note by="ana" text="Too long." />\n`
				+ `</Decision>`,
		);
	});

	it("requires a decision to say who accepted it and when", () => {
		expect(codes(`<Decision id="${ID}" quote="q"><Note by="a" text="t" /></Decision>`))
			.toContain("missing-attribute");
	});

	it("keeps a note out of the prose", () => {
		expect(codes(`<Note by="ana" text="Loose." />`)).toContain("bad-parent");
	});

	/** A note's text is an attribute, so children are a hand-edit gone wrong. */
	it("rejects a note written with its text between the tags", () => {
		expect(
			codes(
				`<Decision id="${ID}" quote="q" by="a" at="t">\n`
					+ `<Note by="ana">\n\nToo long.\n\n</Note>\n`
					+ `</Decision>`,
			),
		).toContain("unexpected-children");
	});

	it("requires ULID ids", () => {
		expect(codes(`<Callout id="nope" type="note">x</Callout>`)).toContain("bad-id");
	});

	/** The dialect carries no versions; one written by hand is just unknown. */
	it("rejects a version attribute", () => {
		expect(codes(`<Callout id="${ID}" version="1" type="note">x</Callout>`))
			.toContain("unknown-attribute");
	});

	it("enforces required and unknown attributes", () => {
		expect(codes(`<Callout id="${ID}">x</Callout>`)).toContain("missing-attribute");
		expect(codes(`<Callout id="${ID}" type="note" bogus="x">y</Callout>`))
			.toContain("unknown-attribute");
	});

	it("enforces enum values", () => {
		expect(codes(`<Callout id="${ID}" type="shout">x</Callout>`))
			.toContain("bad-attribute-value");
	});

	it("enforces parent constraints", () => {
		expect(codes(`<Tab id="${ID}" label="Solo">x</Tab>`)).toContain("bad-parent");
		expect(codes(`<Option id="${ID}" label="Loose" />`)).toContain("bad-parent");
	});

	it("enforces allowed children", () => {
		expect(codes(`<Tabs id="${ID}">\n\ntext\n\n</Tabs>`)).toContain("unexpected-child");
		expect(codes(`<Tabs id="${ID}"></Tabs>`)).toContain("missing-children");
		expect(codes(`<Option id="${ID}" label="x">\n\nchild\n\n</Option>`))
			.toContain("unexpected-children");
	});

	it("forbids recursive layout components", () => {
		let nested = `<Tabs id="${ID}">\n`
			+ `<Tab id="${ID2}" label="Outer">\n`
			+ `<Tabs id="${ID3}">\n`
			+ `<Tab id="${ID}" label="Inner">\n\nx\n\n</Tab>\n`
			+ `</Tabs>\n`
			+ `</Tab>\n`
			+ `</Tabs>`;
		expect(codes(nested)).toContain("bad-nesting");
	});

	it("rejects a flow component used inline", () => {
		expect(codes(`text <Callout id="${ID}" type="note">x</Callout> more`))
			.toContain("wrong-kind");
	});

	it("round-trips components canonically", () => {
		let source = `<Callout id="${ID}" type="warning" title="Careful">\n\nBody.\n\n</Callout>`;
		let out = canonical(source);
		expect(out).toContain(`<Callout id="${ID}"`);
		expect(out).toContain('type="warning"');
	});
});

describe("limits", () => {
	it("rejects oversized source", () => {
		let result = validate(parse("text"), { bytes: 512 * 1024 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]!.code).toBe("source-too-large");
	});

	it("rejects tables beyond the column limit", () => {
		let header = `| ${Array.from({ length: 25 }, (_, i) => `c${i}`).join(" | ")} |`;
		let divider = `| ${Array.from({ length: 25 }, () => "-").join(" | ")} |`;
		expect(codes(`${header}\n${divider}`)).toContain("table-too-wide");
	});

	it("rejects tables beyond the row limit", () => {
		// The counterpart to the width limit, and the one the editor's rails
		// hold themselves to: a plan that reaches either is refused by the
		// server, which cannot undo the update and so rotates the room's epoch.
		let rows = Array.from({ length: limits.MAX_TABLE_ROWS + 1 }, () => "| x |").join("\n");
		expect(codes(`| c |\n| - |\n${rows}`)).toContain("table-too-tall");
	});

	it("rejects excessive nesting", () => {
		let deep = Array.from({ length: 24 }, (_, i) => `${"  ".repeat(i)}- level`).join("\n");
		expect(codes(deep)).toContain("too-deep");
	});

	it("rejects over-long attribute text", () => {
		let long = "x".repeat(120);
		expect(codes(`<Callout id="${ID}" type="note" title="${long}">y</Callout>`))
			.toContain("attribute-too-long");
	});

	it("bounds questionnaire projections only by the source size", () => {
		let questionnaire = (text: string) =>
			`<Questionnaire id="${ID}">\n`
			+ `<Question id="${ID2}" header="${text}" prompt="${text}" multiple="false">\n`
			+ `<Option id="${ID3}" label="${text}" description="${text}" />\n`
			+ `<Answer value="${text}" />\n`
			+ `</Question>\n`
			+ `</Questionnaire>`;
		accepts(questionnaire("x".repeat(5_000)));
		let source = questionnaire("x".repeat(limits.MAX_SOURCE_BYTES));
		let result = validate(parse(source), { bytes: new TextEncoder().encode(source).byteLength });
		expect(result.ok ? [] : result.issues.map(issue => issue.code)).toEqual(["source-too-large"]);
	});
});

describe("diagnostics", () => {
	it("reports every issue with a structural path", () => {
		let result = validate(parse(`<Callout id="bad">x</Callout>`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues.length).toBeGreaterThan(1);
		for (let issue of result.issues) expect(issue.path).toStartWith("root");
	});

	it("does not echo document prose", () => {
		let secret = "hunter2-should-not-leak";
		let result = validate(parse(`<Callout id="bad" type="note">${secret}</Callout>`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(JSON.stringify(result.issues)).not.toContain(secret);
	});
});

// Exact pending-card callback from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
it("accepts a pending conversation question with no options", () => {
	let source = `<Questionnaire id="${ID}" thread="thread-a" status="open">\n`
		+ `<Question id="${ID2}" header="Auth" prompt="Which system?" multiple="false" />\n`
		+ `</Questionnaire>`;
	accepts(source);
	expect(canonical(source)).toContain("Which system?");
	accepts(source.replace('status="open"', 'status="discarded"'));
	expect(codes(source.replace('thread="thread-a" ', ""))).toContain("missing-children");
	expect(
		codes(
			source.replace(
				"</Questionnaire>",
				`<Question id="${ID3}" header="Other" prompt="Another?" multiple="false" />\n</Questionnaire>`,
			),
		),
	).toContain("missing-children");
});
