import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Diagram } from "../diagram";
import { DIAGRAM_FIXTURES } from "../fixtures";

let graph = DIAGRAM_FIXTURES.find((fixture) => fixture.type === "architecture")?.spec;
let chart = DIAGRAM_FIXTURES.find((fixture) => fixture.type === "bar")?.spec;

test("two diagrams keep SVG IDs and accessible names independent", () => {
	expect(graph).toBeDefined();
	let markup = renderToStaticMarkup(
		<>
			<Diagram spec={graph} />
			<Diagram spec={graph} />
		</>,
	);
	let ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
	let references = [...markup.matchAll(/marker-end="url\(#([^)]+)\)"/g)].map((match) => match[1]);
	let svgLabels = [...markup.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);

	expect(ids.length).toBeGreaterThan(0);
	expect(new Set(ids).size).toBe(ids.length);
	expect(references.every((id) => ids.includes(id))).toBe(true);
	expect(svgLabels).toHaveLength(2);
	expect(svgLabels[0]).not.toBe(svgLabels[1]);
});

test("separate React roots do not reuse SVG resource IDs", () => {
	let first = renderToStaticMarkup(<Diagram spec={graph} />);
	let second = renderToStaticMarkup(<Diagram spec={graph} />);
	let firstIds = [...first.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
	let secondIds = new Set([...second.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
	expect(firstIds.filter((id) => secondIds.has(id))).toEqual([]);
});

test("renderer errors appear as escaped text and chart remains a semantic graphic", () => {
	expect(chart).toBeDefined();
	let error = renderToStaticMarkup(<Diagram spec={{ type: "<unsafe>" }} />);
	let valid = renderToStaticMarkup(<Diagram spec={chart} />);

	expect(error).toContain('role="alert"');
	expect(error).not.toContain("<unsafe>");
	expect(valid).toContain('role="img"');
	expect(valid).toContain("<title");
	expect(valid).toContain("<desc");
});

test("a stepped diagram offers one restart control beside a labelled icon stepper", () => {
	let stepped = DIAGRAM_FIXTURES.map((fixture) =>
		renderToStaticMarkup(<Diagram spec={fixture.spec} />)
	)
		.find((markup) => markup.includes('aria-label="Next step"'));
	expect(stepped).toBeDefined();
	expect(stepped).toContain('aria-label="Previous step"');
	expect(stepped).toContain('aria-label="Restart diagram"');
	expect(stepped).not.toContain("Replay");
	expect(stepped).not.toContain("Reset");
	let buttons = [...stepped!.matchAll(/<button class="ch-diagram__control"[^>]*>(.*?)<\/button>/g)];
	expect(buttons.length).toBeGreaterThanOrEqual(3);
	for (let [, inner] of buttons) expect(inner).toMatch(/^<svg aria-hidden="true"/);
});
