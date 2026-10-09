import { expect, test } from "bun:test";

import { DIAGRAM_ALIASES, DIAGRAM_TYPES, renderDiagram } from "@chopin/diagrams";
import { DIAGRAM_FIXTURES } from "@chopin/diagrams/fixtures";

import { VISUAL_DESCRIPTIONS, visualChoices, visualExample } from "./visual-catalog";

test("Jev visual choices cover every canonical SeeCode type exactly once", () => {
	let canonical = Object.keys(DIAGRAM_TYPES).sort();
	expect(Object.keys(VISUAL_DESCRIPTIONS).sort()).toEqual(canonical);
	let choices = visualChoices();
	expect(Object.keys(choices).sort()).toEqual([...canonical, "none", "table"].sort());
	for (let type of canonical) {
		expect(choices[type]).toContain("Requires:");
		expect(choices[type]!.length).toBeLessThanOrEqual(500);
		expect(visualExample(type)?.type).toBe(type);
		expect(renderDiagram(visualExample(type)!).ok).toBe(true);
	}
	for (let alias of Object.keys(DIAGRAM_ALIASES)) {
		expect(choices).not.toHaveProperty(alias);
	}
	expect(DIAGRAM_FIXTURES).toHaveLength(canonical.length);
});

test("unknown visual type has no example", () => {
	expect(visualExample("not-a-type")).toBeUndefined();
});
