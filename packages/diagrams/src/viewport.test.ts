import { expect, test } from "bun:test";
import { DIAGRAM_FIXTURES } from "./fixtures";
import { renderDiagram } from "./render";
import { fitDiagram } from "./viewport";

test("a wide architecture gets a narrower derived layout without changing its source or identity", () => {
	let spec = DIAGRAM_FIXTURES.find(fixture => fixture.type === "architecture")!.spec;
	let source = JSON.stringify(spec);
	let native = renderDiagram(spec);
	let compact = renderDiagram(spec, { availableWidth: 700 });
	expect(native.ok && compact.ok).toBe(true);
	if (!native.ok || !compact.ok) return;
	expect(compact.viewBox[2]).toBeLessThan(native.viewBox[2]);
	expect(compact.graph).toEqual(native.graph);
	expect(compact.steps).toBe(native.steps);
	expect(compact.motion).toBe(native.motion);
	expect(compact.body).toContain('data-sc-group="core"');
	expect(JSON.stringify(spec)).toBe(source);
});

test("a graph already within its lane keeps the authored layout", () => {
	let spec = { type: "architecture", nodes: [{ id: "one", label: "One", row: 0, col: 0 }] };
	expect(renderDiagram(spec, { availableWidth: 900 })).toEqual(renderDiagram(spec));
});

test("semantic lane, stage and chart layouts retain their native axes", () => {
	for (let type of ["swimlane", "medallion", "sequence", "bar"]) {
		let spec = DIAGRAM_FIXTURES.find(fixture => fixture.type === type)!.spec;
		expect(renderDiagram(spec, { availableWidth: 300 })).toEqual(renderDiagram(spec));
	}
});

test("fit retains a readable lower bound for dense diagrams and never enlarges small diagrams", () => {
	expect(fitDiagram(2000, 300)).toBe(0.85);
	expect(fitDiagram(1000, 900)).toBe(0.9);
	expect(fitDiagram(500, 900)).toBe(1);
});
