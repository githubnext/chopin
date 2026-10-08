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

test("viewer style maps color and font roles to Chopin tokens", async () => {
	let css = await Bun.file(new URL("./diagram.css", import.meta.url)).text();
	expect(css).toContain("--sc-accent: var(--color-brand);");
	expect(css).toContain("--sc-paper: var(--color-page);");
	expect(css).toMatch(/font-family:\s*var\(--font-sans\)/);
	expect(css).toMatch(/font-family:\s*var\(--font-mono\)/);
	expect(css).not.toContain("fonts.googleapis.com");
});
