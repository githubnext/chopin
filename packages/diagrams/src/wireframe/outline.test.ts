import { describe, expect, it } from "bun:test";

import {
	describeWireframePart,
	describeWireframeProblem,
	wireframeCallouts,
	wireframeLabel,
} from "./outline";
import { parseWireframe } from "./parse";

import type { Wireframe } from "./schema";

function tree(source: string): Wireframe {
	let result = parseWireframe(source);
	if (!result.ok) throw new Error(JSON.stringify(result.problems));
	return result.wireframe;
}

describe("wireframe callouts", () => {
	it("numbers notes in reading order and marks the part each one points at", () => {
		let wireframe = tree(`panel "Settings"
  input "Members" #search
  button "Save" primary
  note "Replaces the free-text field" -> #search
  note "Saves every tab" -> button`);
		let { callouts, marks } = wireframeCallouts(wireframe);
		let [input, button] = wireframe.nodes[0]!.children;
		expect(callouts.map(({ number, text }) => [number, text])).toEqual([
			[1, "Replaces the free-text field"],
			[2, "Saves every tab"],
		]);
		expect(callouts[0]!.target).toBe(input);
		expect(marks.get(input!)).toEqual([1]);
		expect(marks.get(button!)).toEqual([2]);
	});

	it("gathers several notes on one target", () => {
		let wireframe = tree(`card #c
  title "Card"
note "First" -> #c
note "Second" -> #c`);
		expect(wireframeCallouts(wireframe).marks.get(wireframe.nodes[0]!)).toEqual([1, 2]);
	});
});

describe("wireframe label", () => {
	it("names the region after the top-level label", () => {
		expect(wireframeLabel(tree(`panel "Implementation"\n  text "Hi"`))).toBe(
			"Implementation wireframe",
		);
	});

	it("falls back to the first title inside, then to the kind of thing it is", () => {
		expect(wireframeLabel(tree(`stack\n  row\n    title "Inbox"`))).toBe("Inbox wireframe");
		expect(wireframeLabel(tree(`row\n  button "Go"`))).toBe("Wireframe");
	});

	it("keeps a multi-line label on one line", () => {
		expect(wireframeLabel(tree(`panel "Two\\nlines"`))).toBe("Two lines wireframe");
	});
});

describe("wireframe text alternative", () => {
	it("says what a part is, what it says and what state it is in", () => {
		let [panel] = tree(`panel "P"
  button "Delete" danger disabled
  badge "blocked" tone=danger
  disclosure "Tasks"
  tabs active=2
    - One
    - Two
  input "Name" placeholder="Ada"
  row flow
    text "a"
    text "b"`).nodes;
		expect(panel!.children.map(describeWireframePart)).toEqual([
			"Button “Delete”, danger, disabled",
			"Badge “blocked”, danger",
			"Disclosure “Tasks”, closed",
			"Tabs, “Two” selected",
			"Field “Name”, placeholder “Ada”",
			"Row, a sequence",
		]);
	});

	it("selects the first tab when none is chosen", () => {
		expect(describeWireframePart(tree(`tabs\n  - A\n  - B`).nodes[0]!)).toBe(
			"Tabs, “A” selected",
		);
	});
});

describe("wireframe problems", () => {
	it("leads with the first problem's line", () => {
		let result = parseWireframe(`panel\n  buton "x"`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(describeWireframeProblem(result.problems)).toBe('Line 2: Unknown kind "buton".');
	});

	it("counts the rest", () => {
		expect(
			describeWireframeProblem([
				{ line: 1, message: "A." },
				{ line: 3, message: "B." },
				{ line: 4, message: "C." },
			]),
		).toBe("Line 1: A. (2 more problems)");
	});
});
