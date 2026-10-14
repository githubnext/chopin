import { expect, test } from "bun:test";
import { barChartLoadingHeight } from "./chart-frame.mjs";
import { axisLabels, bands, FITTED_TEXT, thinLabels } from "./core/render/charts/fit.mjs";
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

test("labels moved inside the axis are thinned where they land, so none overlap", () => {
	let widths = [40, 40, 40, 80];
	let placed = axisLabels([0, 50, 100, 150], widths, 0, 150);
	expect(placed.at(-1)!.index).toBe(3);
	for (let { index, x } of placed) {
		expect(x - widths[index] / 2).toBeGreaterThanOrEqual(0);
		expect(x + widths[index] / 2).toBeLessThanOrEqual(150);
	}
	for (let k = 1; k < placed.length; k++) {
		let [a, b] = [placed[k - 1], placed[k]];
		expect(b.x - a.x).toBeGreaterThanOrEqual((widths[a.index] + widths[b.index]) / 2 + 8);
	}
});

test("bands narrow with the column but keep a gap between bars", () => {
	expect(bands(4, 400)).toEqual({ slot: 100, group: 62 });
	let tight = bands(40, 300);
	expect(tight.slot - tight.group).toBeGreaterThanOrEqual(4);
	expect(tight.group).toBeGreaterThan(0);
});

test("bar, line, waterfall and scatter charts redraw to a narrow column", () => {
	for (let type of ["bar", "line", "waterfall", "scatter"]) {
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

test("bar loading frame matches fitted and native chart heights", () => {
	for (let count of [2, 12, 40]) {
		for (let label of [(index: number) => String(index), (index: number) => `Workload ${index}`]) {
			let data: Array<[string, number]> = Array.from({ length: count }, (_, index) => [
				label(index),
				160 + index,
			]);
			for (let width of [324, 450, 700, 850]) {
				let chart = renderDiagram({ type: "bar", data, unit: "ms" }, {
					availableWidth: width,
				});
				if (!chart.ok) throw new Error("bar did not render");
				expect(barChartLoadingHeight(data, "ms", width) - 40)
					.toBeCloseTo(chart.viewBox[3], 4);
			}
		}
	}
});

test("a chart that fits keeps its authored layout", () => {
	for (let type of ["bar", "line", "waterfall", "scatter", "radar"]) {
		let native = renderDiagram(fixture(type));
		if (!native.ok) throw new Error(`${type} did not render`);
		for (let width of [native.viewBox[2], 1440]) {
			expect(renderDiagram(fixture(type), { availableWidth: width })).toEqual(native);
		}
	}
});

test("charts without a fitted layout stay scaled", () => {
	for (let type of ["radar", "sankey", "treemap"]) {
		expect(renderDiagram(fixture(type), { availableWidth: 300 })).toEqual(
			renderDiagram(fixture(type)),
		);
	}
});

test("fitted labels stay inside the drawing", () => {
	let specs = [
		{
			type: "bar",
			unit: "ms",
			categories: ["Cold start median for builds", "Warm start median for builds"],
			series: [{ name: "Before", values: [520, 610] }, { name: "After", values: [310, 280] }],
		},
		{ type: "bar", focal: "P", data: [..."ABCDEFGHIJKLMNOP"].map((c, i) => [c, 40 + i * 4]) },
		{ type: "bar", unit: "%", data: [["Baseline run", -12], ["Cached", 24]] },
		fixture("waterfall"),
		fixture("scatter"),
	];
	for (let spec of specs) {
		let fitted = renderDiagram(spec, { availableWidth: 324 });
		if (!fitted.ok) throw new Error("chart did not render");
		let [left, , width] = fitted.viewBox;
		for (let [, x] of fitted.body.matchAll(/<text[^>]*\sx="(-?[\d.]+)"/g)) {
			expect(Number(x)).toBeGreaterThanOrEqual(left);
			expect(Number(x)).toBeLessThanOrEqual(left + width);
		}
	}
});

test("a single line without room for its end label names itself in a legend", () => {
	let fitted = renderDiagram({
		type: "line",
		x: ["Jan", "Feb", "Mar"],
		series: [{ name: "Median cold start p95 ms", values: [1, 2, 3] }],
	}, { availableWidth: 300 });
	if (!fitted.ok) throw new Error("line did not render");
	expect(fitted.body).toContain("Median cold start p95 ms");
	expect(fitted.body).toContain("sc-legend");
});
