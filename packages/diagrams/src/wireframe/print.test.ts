import { describe, expect, it } from "bun:test";

import { parseWireframe } from "./parse";
import { printWireframe } from "./print";
import { type Wireframe, WIREFRAME_KINDS, type WireframeKind, type WireframeNode } from "./schema";

function parsed(source: string): Wireframe {
	let result = parseWireframe(source);
	if (!result.ok) throw new Error(JSON.stringify(result.problems));
	return result.wireframe;
}

const CANONICAL = [
	`panel "Implementation"
  header
    button "Approve and build this plan" primary
  text "Build 4f2a9c01 on Laptop" muted
  disclosure "0 of 2 tasks complete" open
    card
      badge "queued" tone=info
      title "Parse wireframe fences"
      list ordered
        - Unknown kinds report a line number
        - "\\"Quoted\\" first"`,
	`row wrap align=between
  button "Say \\"hi\\"\\\\now\\nplease" #go danger disabled
  input placeholder="Search plans" value=draft-1
note "Starts the run" #explain -> #go
note "Any input" -> input`,
	`tabs active=2
  - Overview
  - Tasks
divider
image "Hero" ratio=wide`,
	`row flush h=lg
  nav vertical n=4 active=2
  grid cols=3 w=5
    box "Area" shaded h=sm width=md repeat=3
    fill
    lines n=3 repeat=2
    icon
  button`,
];

describe("wireframe printer", () => {
	it("prints canonical sources unchanged", () => {
		for (let source of CANONICAL) expect(printWireframe(parsed(source))).toBe(source);
	});

	it("keeps the tree apart from spans when printing non-canonical source", () => {
		let messy = parsed('\uFEFFrow   flow\n\n  card "A"  #a\n\n  card "B"\nnote "x" -> #a');
		let reparsed = parsed(printWireframe(messy));
		expect(withoutSpans(reparsed)).toEqual(withoutSpans(messy));
		expect(reparsed.nodes[0]!.children[1]!.span).toEqual({ start: 3, end: 3 });
		expect(messy.nodes[0]!.children[1]!.span).toEqual({ start: 5, end: 5 });
	});

	it("canonicalises token order, spacing and blank lines", () => {
		let messy = 'button   primary  #go "Go"\r\n\n\nlist\n  -   spaced item  ';
		expect(printWireframe(parsed(messy))).toBe('button "Go" #go primary\nlist\n  - spaced item');
	});

	it("round-trips generated wireframes", () => {
		let random = seeded(7);
		for (let run = 0; run < 300; run++) {
			let wireframe = generate(random);
			let printed = printWireframe(wireframe);
			let reparsed = parsed(printed);
			expect(reparsed).toEqual(wireframe);
			expect(printWireframe(reparsed)).toBe(printed);
		}
	});
});

function withoutSpans(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (key, inner) => key === "span" ? undefined : inner));
}

function seeded(seed: number): () => number {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}

const WORDS = [
	"Plan",
	'say "hi"',
	"a\\b",
	"two\nlines",
	"  padded ",
	"#tag",
	"-> arrow",
	"é ✓",
	"x=y",
];

function generate(random: () => number): Wireframe {
	let pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
	let line = 0;
	let ids = 0;
	let kinds = Object.keys(WIREFRAME_KINDS).filter(kind => kind !== "note") as WireframeKind[];
	let node = (depth: number): WireframeNode => {
		let kind = pick(kinds);
		let spec = WIREFRAME_KINDS[kind];
		let start = ++line;
		let made: WireframeNode = {
			kind,
			flags: (spec.flags as readonly string[]).filter(() => random() < 0.4),
			props: {},
			children: [],
			items: [],
			span: { start, end: start },
		};
		if (spec.label === "required" || (spec.label === "optional" && random() < 0.5)) {
			made.label = pick(WORDS);
		}
		if (random() < 0.3) made.id = `part-${++ids}`;
		if (spec.children === "blocks" && depth < 4) {
			let count = Math.floor(random() * 4);
			for (let i = 0; i < count; i++) made.children.push(node(depth + 1));
		}
		if (spec.children === "items") {
			let count = 1 + Math.floor(random() * 3);
			for (let i = 0; i < count; i++) {
				let at = ++line;
				made.items.push({ text: pick(WORDS), span: { start: at, end: at } });
			}
		}
		for (let [key, value] of Object.entries(spec.props as Record<string, unknown>)) {
			if (random() < 0.5) continue;
			if (key === "n" && made.items.length) continue;
			if (key === "repeat") value = ["2", "3"];
			if (value === "count") {
				if (key === "n") continue;
				let total = made.items.length || 1 + Math.floor(random() * 3);
				let chosen = 1 + Math.floor(random() * total);
				made.props[key] = String(chosen);
				if (!made.items.length) made.props.n = String(Math.max(Number(made.props.n ?? 0), total));
			} else if (value === "text") made.props[key] = pick(WORDS);
			else made.props[key] = pick(value as string[]);
		}
		if ("n" in spec.props && !made.items.length && !made.props.n && random() < 0.5) {
			made.props.n = String(1 + Math.floor(random() * 3));
		}
		made.span.end = line;
		return made;
	};
	let nodes = Array.from({ length: 1 + Math.floor(random() * 3) }, () => node(1));
	let start = ++line;
	nodes.push({
		kind: "note",
		label: pick(WORDS),
		flags: [],
		props: {},
		target: nodes[0]!.id ? `#${nodes[0]!.id}` : "note-free",
		children: [],
		items: [],
		span: { start, end: start },
	});
	if (!nodes[0]!.id) nodes.pop();
	return { nodes };
}
