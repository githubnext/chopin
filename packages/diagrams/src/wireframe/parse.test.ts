import { describe, expect, it } from "bun:test";

import { parseWireframe, resolveWireframeTarget } from "./parse";
import {
	MAX_WIREFRAME_DEPTH,
	MAX_WIREFRAME_LABEL,
	MAX_WIREFRAME_NODES,
	MAX_WIREFRAME_PROBLEMS,
	MAX_WIREFRAME_SOURCE_BYTES,
	WIREFRAME_KINDS,
	type WireframeProblem,
} from "./schema";

const IMPLEMENTATION = `panel "Implementation"
  header
    button "Approve and build this plan" primary
  text "Build 4f2a9c01 on Laptop" muted
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
								label: "Build 4f2a9c01 on Laptop",
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

const PROPOSALS = [
	`header
  title "Today"
  button "All notes"
title "Worth revisiting"
grid cols=3
  card repeat=3
    image ratio=wide
    lines n=2
    button "Open"
title "Possible connections"
grid cols=2
  card repeat=2
    row flow
      box shaded h=sm
      box shaded h=sm
    lines n=1
    button "Read both"`,
	`header flush
  title "Project / Plan"
  button "Share" primary
row flush h=xl
  nav vertical active=2
    - Projects
    - Documents
    - Settings
  stack w=5
    title "Plan title"
    lines n=4
    image ratio=wide
    lines n=3
  stack w=2
    text "Comments" strong
    card repeat=3
      row
        icon
        lines n=2`,
	`header
  title "Templates"
  row
    input placeholder="Search"
    button "New" primary
tabs active=1
  - All
  - Plans
  - Specs
grid cols=3
  card repeat=6
    image ratio=wide
    lines n=1`,
	`card width=sm
  badge "Open"
  title "Which storage engine?"
  lines n=1
  stack
    box shaded
      text "PostgreSQL"
    box
      text "SQLite"
    box
      text "Redis"
  row align=end
    button "Skip"
    button "Submit" primary`,
	`row flush h=lg
  nav vertical active=2
    - Profile
    - Machines
    - Billing
  stack
    header
      title "Machines"
      button "Add machine" primary
    card repeat=2
      row
        icon
        lines n=1
        badge "Online"
        button "Remove"`,
	`grid cols=3
  card
    text "Builds" muted
    title "128"
  card
    text "Pass rate" muted
    title "94%"
  card
    text "Median" muted
    title "4m"
card "Build time"
  fill h=lg
card "Recent builds"
  row repeat=4
    icon
    lines n=1
    badge "Passed"`,
];

describe("low-fidelity language", () => {
	it("parses every new kind", () => {
		let result = parseWireframe(`box "Area" shaded h=lg width=md w=3 repeat=2
  fill "Chart" h=xl
  lines n=4 w=2
  icon repeat=3
grid cols=4 repeat=2
  box`);
		expect(result.ok).toBe(true);
	});

	it("accepts w and repeat on every kind but a note", () => {
		for (let kind of Object.keys(WIREFRAME_KINDS)) {
			let props = WIREFRAME_KINDS[kind as keyof typeof WIREFRAME_KINDS].props as Record<
				string,
				unknown
			>;
			expect(Object.hasOwn(props, "w")).toBe(kind !== "note");
			expect(Object.hasOwn(props, "repeat")).toBe(kind !== "note");
		}
	});

	it("parses every proposal sample", () => {
		for (let source of PROPOSALS) {
			let result = parseWireframe(source);
			if (!result.ok) throw new Error(JSON.stringify(result.problems));
		}
	});

	it("accepts a button without a label, and flush on a row and header", () => {
		expect(parseWireframe("button primary\nrow flush\n  button\nheader flush").ok).toBe(true);
	});

	it("refuses bad values with the allowed set", () => {
		expect(only("box h=huge").message).toBe("h must be one of: xs, sm, md, lg, xl.");
		expect(only("card width=xl").message).toBe("width must be one of: sm, md, lg.");
		expect(only('text w=0 "x"').message).toContain("w must be one of: 1, 2");
		expect(only("box repeat=1").message).toContain("repeat must be one of: 2, 3");
		expect(only("grid cols=7").message).toContain("cols must be one of: 2, 3");
		expect(only("lines n=9").message).toContain("n must be one of: 1, 2");
	});

	it("refuses w and repeat on a note, and flush elsewhere", () => {
		expect(only('row\nnote "x" w=2 -> row').message).toBe('note does not accept "w".');
		expect(only("stack flush").message).toContain('does not accept the flag "flush"');
	});

	it("draws n placeholder items on nav and list, and checks active against them", () => {
		expect(parseWireframe("nav vertical n=4 active=2").ok).toBe(true);
		expect(parseWireframe("list n=3").ok).toBe(true);
		expect(only("nav n=3 active=4")).toEqual({ line: 1, message: "active=4 but nav has 3 items." });
	});

	it("refuses items together with n", () => {
		expect(only("nav n=2\n  - One")).toEqual({
			line: 1,
			message: "nav has both items and n=; use one.",
		});
	});

	it("refuses repeats that expand past the node bound, without hanging", () => {
		let found = only('stack repeat=12\n  stack repeat=12\n    stack repeat=12\n      text "x"');
		expect(found).toEqual({
			line: 1,
			message: `Repeats expand the wireframe past ${MAX_WIREFRAME_NODES} parts.`,
		});
		let nested = Array.from({ length: 9 }, (_, i) => `${"  ".repeat(i)}stack repeat=12`);
		expect(only(nested.join("\n")).message).toContain("Repeats expand");
		expect(parseWireframe("grid\n  card repeat=12\n    lines").ok).toBe(true);
	});

	it("reports the part whose repeat pushes the total over", () => {
		let found = only(
			"grid\n  icon repeat=12\nstack repeat=12\n  stack repeat=12\n    icon\n    icon",
		);
		expect(found.line).toBe(3);
	});
});
