import { createPaletteState, gridRows, paletteReducer } from "@chopin/color";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PaletteGrid } from "./palette-grid";

let state = createPaletteState({
	themes: {
		light: [
			{
				name: "gray",
				swatches: [
					{ step: "400", value: { l: 0.74029, c: 0.00856, h: 95 } },
					{ step: "450", value: { l: 0.6681, c: 0.0105, h: 95 } },
				],
			},
			{ name: "empty", swatches: [] },
		],
	},
});

test("labels swatches, marks edits and selection, and uses roving tabindex", () => {
	let ref = { hue: "gray", step: "450" };
	let edited = paletteReducer(paletteReducer(state, { type: "select", ref }), {
		type: "edit",
		ref,
		value: { l: 0.64, c: 0.0105, h: 95 },
	});
	let markup = renderToStaticMarkup(<PaletteGrid onActivate={() => {}} rows={gridRows(edited)} />);
	expect(markup).toContain('aria-label="Gray 400, oklch(0.74029 0.00856 95)"');
	expect(markup).toContain('aria-label="Gray 450, oklch(0.64 0.0105 95), edited"');
	expect(markup).toContain('aria-pressed="true"');
	expect(markup.match(/tabindex="0"/g)!.length).toBe(1);
	expect(markup).toContain('data-edited="true"');
	expect(markup).toContain("No colors");
});

test("shows a shared step header only when every row matches", () => {
	let mixed = renderToStaticMarkup(<PaletteGrid onActivate={() => {}} rows={gridRows(state)} />);
	expect(mixed).not.toContain("cv-palette-grid-steps");
	let matching = gridRows(state).find(row => row.cells.length)!;
	let markup = renderToStaticMarkup(
		<PaletteGrid onActivate={() => {}} rows={[matching, { ...matching, name: "blue" }]} />,
	);
	expect(markup).toContain("cv-palette-grid-steps");
	expect(markup).toContain(">400<");
	expect(markup).toContain(">450<");
});

test("gives the first available swatch the sole default tab stop", () => {
	let rows = gridRows(state);
	let markup = renderToStaticMarkup(
		<PaletteGrid onActivate={() => {}} rows={[rows[1], rows[0]]} />,
	);
	expect(markup.match(/tabindex="0"/g)!.length).toBe(1);
	expect(markup).toContain('aria-label="Gray"');
});
