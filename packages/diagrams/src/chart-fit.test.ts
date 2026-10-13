import { expect, test } from "bun:test";
import { bands, FITTED_TEXT, thinLabels } from "./core/render/charts/fit.mjs";
import { DIAGRAM_FIXTURES } from "./fixtures";
import { renderDiagram } from "./render";

let fixture = (type: string) => DIAGRAM_FIXTURES.find(item => item.type === type)!.spec;

test("thinning keeps every label that has room", () => {
	expect(thinLabels([0, 50, 100, 150], [20, 20, 20, 20])).toEqual([0, 1, 2, 3]);
});

test("thinning takes every k-th label and always shows the last", () => {
	let positions = Array.from({ length: 30 }, (_, i) => i * 10);
	let kept = thinLabels(positions, positions.map(() => 60));
	expect(kept[0]).toBe(0);
	expect(kept.at(-1)).toBe(29);
	for (let k = 1; k < kept.length; k++) {
		expect(positions[kept[k]] - positions[kept[k - 1]]).toBeGreaterThanOrEqual(60 + 8);
	}
});

test("thinning shows one label when no two can stand", () => {
	expect(thinLabels([0, 10], [100, 100])).toEqual([0]);
	expect(thinLabels([5], [100])).toEqual([0]);
});

test("bands narrow with the column but keep a gap between bars", () => {
	expect(bands(4, 400)).toEqual({ slot: 100, group: 62 });
	let tight = bands(40, 300);
	expect(tight.slot - tight.group).toBeGreaterThanOrEqual(4);
	expect(tight.group).toBeGreaterThan(0);
});

test("a bar or line chart wider than its column redraws to it at legible size", () => {
	for (let type of ["bar", "line"]) {
		let native = renderDiagram(fixture(type));
		let fitted = renderDiagram(fixture(type), { availableWidth: 324 });
		if (!native.ok || !fitted.ok) throw new Error(`${type} did not render`);
		expect(native.viewBox[2]).toBeGreaterThan(324);
		expect(fitted.viewBox[2]).toBeLessThanOrEqual(324);
		expect(fitted.body).toStartWith('<g class="sc-fitted">');
		expect(fitted.steps).toBe(native.steps);
		expect(fitted.motion).toBe(native.motion);
	}
	expect(FITTED_TEXT).toBeGreaterThanOrEqual(12);
});

test("upright bars give way to labelled rows when labels outgrow their bands", () => {
	let short = renderDiagram({ type: "bar", data: [["A", 1], ["B", 2], ["C", 3], ["D", 4]] }, {
		availableWidth: 200,
	});
	let long = renderDiagram(fixture("bar"), { availableWidth: 324 });
	if (!short.ok || !long.ok) throw new Error("bar did not render");
	expect(short.body).toContain("sc-grow-y");
	expect(long.body).toContain("sc-grow-x");
});

test("a chart that fits, or nearly fits, keeps its authored layout", () => {
	for (let type of ["bar", "line", "radar"]) {
		let native = renderDiagram(fixture(type));
		if (!native.ok) throw new Error(`${type} did not render`);
		for (let width of [native.viewBox[2], native.viewBox[2] * 0.9, 1440]) {
			expect(renderDiagram(fixture(type), { availableWidth: width })).toEqual(native);
		}
	}
});

test("charts without a fitted layout stay scaled", () => {
	for (let type of ["radar", "sankey", "waterfall"]) {
		expect(renderDiagram(fixture(type), { availableWidth: 300 })).toEqual(
			renderDiagram(fixture(type)),
		);
	}
});
