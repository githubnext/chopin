import { describe, expect, it } from "bun:test";

import { parseWireframe, resolveWireframeTarget } from "./parse";
import {
	MAX_WIREFRAME_DEPTH,
	MAX_WIREFRAME_LABEL,
	MAX_WIREFRAME_NODES,
	MAX_WIREFRAME_PROBLEMS,
	MAX_WIREFRAME_SOURCE_BYTES,
	type WireframeProblem,
} from "./schema";

const IMPLEMENTATION = `panel "Implementation"
  header
    button "Approve and build this plan" primary
  text "Build on Laptop · 4f2a9c01" muted
  disclosure "0 of 2 tasks complete" open
    card
      badge "queued"
      title "Parse wireframe fences"
      text "Bounded parser in packages/diagrams."
      list
        - Unknown kinds report a line number`;

function problems(source: string): WireframeProblem[] {
	let result = parseWireframe(source);
	if (result.ok) throw new Error("expected problems");
	return result.problems;
}

function only(source: string): WireframeProblem {
	let found = problems(source);
	expect(found).toHaveLength(1);
	return found[0]!;
}

describe("wireframe parser", () => {
	it("parses the Implementation panel sample with source spans", () => {
		let result = parseWireframe(IMPLEMENTATION);
		expect(result).toEqual({
			ok: true,
			wireframe: {
				nodes: [
					{
						kind: "panel",
						label: "Implementation",
						flags: [],
						props: {},
						items: [],
						span: { start: 1, end: 11 },
						children: [
							{
								kind: "header",
								flags: [],
								props: {},
								items: [],
								span: { start: 2, end: 3 },
								children: [
									{
										kind: "button",
										label: "Approve and build this plan",
										flags: ["primary"],
										props: {},
										items: [],
										children: [],
										span: { start: 3, end: 3 },
									},
								],
							},
							{
								kind: "text",
								label: "Build on Laptop · 4f2a9c01",
								flags: ["muted"],
								props: {},
								items: [],
								children: [],
								span: { start: 4, end: 4 },
							},
							{
								kind: "disclosure",
								label: "0 of 2 tasks complete",
								flags: ["open"],
								props: {},
								items: [],
								span: { start: 5, end: 11 },
								children: [
									{
										kind: "card",
										flags: [],
										props: {},
										items: [],
										span: { start: 6, end: 11 },
										children: [
											{
												kind: "badge",
												label: "queued",
												flags: [],
												props: {},
												items: [],
												children: [],
												span: { start: 7, end: 7 },
											},
											{
												kind: "title",
												label: "Parse wireframe fences",
												flags: [],
												props: {},
												items: [],
												children: [],
												span: { start: 8, end: 8 },
											},
											{
												kind: "text",
												label: "Bounded parser in packages/diagrams.",
												flags: [],
												props: {},
												items: [],
												children: [],
												span: { start: 9, end: 9 },
											},
											{
												kind: "list",
												flags: [],
												props: {},
												children: [],
												span: { start: 10, end: 11 },
												items: [
													{
														text: "Unknown kinds report a line number",
														span: { start: 11, end: 11 },
													},
												],
											},
										],
									},
								],
							},
						],
					},
				],
			},
		});
	});

	it("accepts a flow row with parallel stack columns", () => {
		let result = parseWireframe(
			'row flow\n  card "Plan"\n  stack\n    card "Build"\n    card "Test"\n  card "Ship"',
		);
		if (!result.ok) throw new Error(JSON.stringify(result.problems));
		let [row] = result.wireframe.nodes;
		expect(row!.flags).toEqual(["flow"]);
		expect(row!.children.map(child => child.kind)).toEqual(["card", "stack", "card"]);
		expect(row!.children[1]!.children).toHaveLength(2);
		expect(only("stack flow").message).toBe('stack does not accept the flag "flow".');
	});

	it("reads ids, properties, escapes, notes and blank lines", () => {
		let result = parseWireframe(
			[
				"row align=between",
				"",
				'  button #go "Say \\"hi\\"\\\\now" primary',
				'  input placeholder="Search plans" value=draft-1 disabled',
				"  tabs active=2",
				"    - Overview",
				'    - "  padded "',
				'note "Line one\\nline two" -> #go',
				'note "Any badge" -> input',
			].join("\r\n"),
		);
		if (!result.ok) throw new Error(JSON.stringify(result.problems));
		let [row, first, second] = result.wireframe.nodes;
		expect(row!.props).toEqual({ align: "between" });
		expect(row!.span).toEqual({ start: 1, end: 7 });
		expect(row!.children[0]).toMatchObject({
			id: "go",
			label: 'Say "hi"\\now',
			flags: ["primary"],
		});
		expect(row!.children[1]).toMatchObject({
			props: { placeholder: "Search plans", value: "draft-1" },
			flags: ["disabled"],
		});
		expect(row!.children[2]!.items.map(item => item.text)).toEqual(["Overview", "  padded "]);
		expect(first).toMatchObject({ label: "Line one\nline two", target: "#go" });
		expect(resolveWireframeTarget(result.wireframe, first!.target!)).toBe(row!.children[0]);
		expect(resolveWireframeTarget(result.wireframe, second!.target!)).toBe(row!.children[1]);
	});

	it("reports indentation with line numbers", () => {
		expect(only("panel\n\tcard")).toEqual({
			line: 2,
			message: "Indent with two spaces, not tabs.",
		});
		expect(only("panel\n \tcard").line).toBe(2);
		expect(only("panel\n   card")).toEqual({
			line: 2,
			message: "Indentation must be a multiple of two spaces.",
		});
		expect(only("panel\n    card")).toEqual({
			line: 2,
			message: "This line is indented more than one level below its parent.",
		});
		expect(only("  panel")).toEqual({
			line: 1,
			message: "This line is indented more than one level below its parent.",
		});
	});

	it("reports unknown kinds, flags and properties", () => {
		expect(only("panel\n  slider")).toEqual({
			line: 2,
			message: 'Unknown kind "slider".',
		});
		expect(only('button "Go" huge')).toEqual({
			line: 1,
			message: 'button does not accept the flag "huge". Allowed: primary, danger, disabled.',
		});
		expect(only('button "Go" primary primary').message).toBe(
			'The flag "primary" is repeated.',
		);
		expect(only("divider tone=info").message).toBe('divider does not accept "tone".');
		expect(only('badge "x" tone=loud').message).toBe(
			"tone must be one of: neutral, info, success, warning, danger.",
		);
		expect(only('badge "x" tone=info tone=danger').message).toBe(
			'The property "tone" is repeated.',
		);
		expect(only("tabs active=0\n  - A").message).toBe("active must be a whole number from 1.");
		expect(only("tabs active=3\n  - A\n  - B")).toEqual({
			line: 1,
			message: "active=3 but tabs has 2 items.",
		});
		expect(only('badge "x" tone=').message).toBe("tone needs a value.");
	});

	it("reports label and token problems", () => {
		expect(only("title")).toEqual({ line: 1, message: "title needs a quoted label." });
		expect(only('divider "x"').message).toBe("divider does not take a label.");
		expect(only('text "a" "b"').message).toBe("text has more than one label.");
		expect(only('text "open').message).toBe("A label is missing its closing quote.");
		expect(only('text "a\\tb"').message).toBe('Unknown escape "\\t". Use \\", \\\\ or \\n.');
		expect(only('text "a\tb"').message).toBe("Text cannot contain control characters.");
		expect(only('text ""').message).toBe("A label cannot be empty.");
		expect(only('text "  "').message).toBe("A label cannot be empty.");
		expect(only('text "a"b').message).toBe("Expected a space after the closing quote.");
		expect(only('text "a" @x').message).toBe('Unexpected "@x".');
		expect(only("Panel").message).toBe('Expected a kind or a "- item" line.');
		expect(only('button "a" #1x').message).toBe(
			"An id is # followed by a letter, then letters, digits, - or _.",
		);
		expect(only('button "a" #a #b').message).toBe("button has more than one id.");
	});

	it("reports children in the wrong place", () => {
		expect(only('title "a"\n  text "b"')).toEqual({
			line: 2,
			message: "title cannot contain other parts.",
		});
		expect(only('list\n  button "a"')).toEqual({
			line: 2,
			message: 'list contains only "- item" lines.',
		});
		expect(only("card\n  - stray")).toEqual({
			line: 2,
			message: 'card cannot contain "- item" lines.',
		});
		expect(only("- stray")).toEqual({
			line: 1,
			message: 'The top level cannot contain "- item" lines.',
		});
		expect(only("list\n  - a\n    - b")).toEqual({
			line: 3,
			message: "An item cannot contain other lines.",
		});
		expect(only("list\n  -").message).toBe('An item needs text after "- ".');
		expect(only('list\n  - "a" b').message).toBe("Expected nothing after the quoted item.");
	});

	it("does not cascade from an invalid parent into its children", () => {
		expect(problems('slider\n  button "a"\n  - item\n  junk junk')).toEqual([
			{ line: 1, message: 'Unknown kind "slider".' },
			{ line: 4, message: 'Unknown kind "junk".' },
		]);
	});

	it("resolves note targets or reports them", () => {
		expect(only('note "a"')).toEqual({
			line: 1,
			message: "note needs a target: -> #id or -> kind.",
		});
		expect(only('button "a" -> #x').message).toBe("Only a note points at a target.");
		expect(only('note "a" -> #missing').message).toBe('No part has the id "missing".');
		expect(only('note "a" -> slider').message).toBe('Unknown target "slider".');
		expect(only('note "a" -> button').message).toBe("No button to point at.");
		expect(only('button "a"\nbutton "b"\nnote "c" -> button')).toEqual({
			line: 3,
			message: "2 parts are a button; give the target an #id.",
		});
		expect(only('note "a" #self -> note').message).toBe("A note cannot point at a note.");
		expect(only('button "a" #x\ntext "b" #x')).toEqual({
			line: 2,
			message: 'The id "x" is already used on line 1.',
		});
		expect(only('note "a" ->').message).toBe('Expected a target after "->".');
	});

	it("reports empty source", () => {
		expect(only("")).toEqual({ line: 1, message: "The wireframe is empty." });
		expect(only("\n  \n")).toEqual({ line: 1, message: "The wireframe is empty." });
	});
});

describe("wireframe limits", () => {
	it("bounds source bytes before reading lines", () => {
		expect(only('text "' + "é".repeat(MAX_WIREFRAME_SOURCE_BYTES / 2) + '"')).toEqual({
			line: 1,
			message: "The wireframe is too large (64 KiB maximum).",
		});
	});

	it("bounds nodes and stops reading", () => {
		let source = Array.from({ length: MAX_WIREFRAME_NODES + 50 }, () => "divider").join("\n");
		expect(only(source)).toEqual({
			line: MAX_WIREFRAME_NODES + 1,
			message: `The wireframe has more than ${MAX_WIREFRAME_NODES} parts.`,
		});
		let items = ["list", ...Array.from({ length: MAX_WIREFRAME_NODES }, () => "  - x")];
		expect(only(items.join("\n")).line).toBe(MAX_WIREFRAME_NODES + 1);
		let full = Array.from({ length: MAX_WIREFRAME_NODES }, () => "divider").join("\n");
		expect(parseWireframe(full).ok).toBe(true);
	});

	it("bounds depth", () => {
		let lines = Array.from({ length: MAX_WIREFRAME_DEPTH }, (_, i) => "  ".repeat(i) + "stack");
		expect(parseWireframe(lines.join("\n")).ok).toBe(true);
		lines.push("  ".repeat(MAX_WIREFRAME_DEPTH) + "divider");
		expect(only(lines.join("\n"))).toEqual({
			line: MAX_WIREFRAME_DEPTH + 1,
			message: `Parts can nest at most ${MAX_WIREFRAME_DEPTH} levels deep.`,
		});
	});

	it("bounds labels, items and property text", () => {
		let fits = "x".repeat(MAX_WIREFRAME_LABEL);
		let long = fits + "x";
		expect(parseWireframe(`text "${fits}"`).ok).toBe(true);
		let message = `Text is longer than ${MAX_WIREFRAME_LABEL} characters.`;
		expect(only(`text "${long}"`).message).toBe(message);
		expect(only(`list\n  - ${long}`).message).toBe(message);
		expect(only(`input placeholder="${long}"`).message).toBe(message);
		expect(only(`button "a" #${"a".repeat(41)}`).message).toBe("An id is at most 40 characters.");
	});

	it("caps reported problems", () => {
		let source = Array.from({ length: 100 }, () => "slider").join("\n");
		expect(problems(source)).toHaveLength(MAX_WIREFRAME_PROBLEMS);
	});

	it("does not echo long hostile tokens", () => {
		let message = only("z".repeat(5000)).message;
		expect(message.length).toBeLessThan(80);
	});

	it("finishes quickly on adversarial input", () => {
		let started = performance.now();
		let hostile = [
			'"'.repeat(60_000),
			"\\".repeat(60_000),
			('text "' + '\\"'.repeat(100) + "\n").repeat(400),
			"list\n" + '  - "'.repeat(10_000),
			"  ".repeat(30_000) + "x",
			"divider" + " ".repeat(60_000) + "x",
			'note "a" -> button\n'.repeat(200) + 'button "b"\n'.repeat(199),
		];
		for (let source of hostile) {
			expect(() => parseWireframe(source)).not.toThrow();
		}
		expect(performance.now() - started).toBeLessThan(500);
	});
});
