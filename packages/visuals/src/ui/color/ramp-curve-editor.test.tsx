import { curveFrom } from "@chopin/color";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChromaGraph } from "./chroma-graph";
import { RampCurveEditor } from "./ramp-curve-editor";

let row = [
	{ l: 0.95, c: 0.02, h: 30 },
	{ l: 0.6, c: 0.15, h: 31 },
	{ l: 0.4, c: 0.1, h: 32 },
];

test("renders endpoints, chroma lines and discard only for an edited row", () => {
	let props = {
		current: row,
		curve: curveFrom(row),
		onCurveChange() {},
		onDiscard() {},
		steps: ["1", "2", "3"],
	};
	let clean = renderToStaticMarkup(<RampCurveEditor {...props} edited={false} />);
	expect(clean).toContain(">Darkest<");
	expect(clean).toContain(">Lightest<");
	expect(clean).toContain('value="40%"');
	expect(clean).toContain('value="95%"');
	expect(clean).toContain('aria-label="Chroma across 3 steps"');
	expect(clean).toContain('stroke-dasharray="4 4"');
	expect(clean).not.toContain("Discard these changes");
	expect(renderToStaticMarkup(<RampCurveEditor {...props} edited />)).toContain(
		"Discard these changes",
	);
});

test("gives each endpoint input and easing menu a distinct accessible name and option values", () => {
	let html = renderToStaticMarkup(
		<RampCurveEditor
			current={row}
			curve={curveFrom(row)}
			edited={false}
			onCurveChange={() => {}}
			onDiscard={() => {}}
			steps={["1", "2", "3"]}
		/>,
	);
	for (
		let name of [
			"Darkest lightness",
			"Darkest hue shift",
			"Darkest easing",
			"Lightest lightness",
			"Lightest hue shift",
			"Lightest easing",
		]
	) expect(html).toContain(`aria-label="${name}"`);
	let values = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
	expect(new Set(values).size).toBe(values.length);
});

test("keeps an out-of-gamut current chroma path within the graph plot", () => {
	let markup = renderToStaticMarkup(
		<ChromaGraph
			values={[
				{ l: 0.6681, c: 0.5, h: 95 },
				{ l: 0.56514, c: 0.0123, h: 95 },
			]}
		/>,
	);
	let path = markup.match(/class="cv-chroma-current" d="([^"]+)"/)?.[1];
	let coordinates = [...(path?.matchAll(/[ML] [\d.]+ (-?[\d.]+)/g) ?? [])].map(match =>
		Number(match[1])
	);

	expect(coordinates).toHaveLength(2);
	for (let y of coordinates) {
		expect(y).toBeGreaterThanOrEqual(8);
		expect(y).toBeLessThanOrEqual(80);
	}
});

test("uses the row's step labels in the chroma graph", () => {
	let markup = renderToStaticMarkup(
		<RampCurveEditor
			current={row}
			curve={curveFrom(row)}
			edited={false}
			onCurveChange={() => {}}
			onDiscard={() => {}}
			steps={["50", "450", "900"]}
		/>,
	);

	for (let step of ["50", "450", "900"]) expect(markup).toContain(`>${step}</text>`);
});
