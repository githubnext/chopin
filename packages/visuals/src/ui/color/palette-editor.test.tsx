import { expect, test } from "bun:test";
import { createPaletteState, paletteReducer } from "@chopin/color";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { contrastOptions, PaletteEditor } from "./palette-editor";

import type { Palette } from "@chopin/color";

let palette: Palette = {
	themes: {
		light: [{
			name: "gray",
			swatches: [
				{ step: "400", value: { l: 0.74, c: 0.008, h: 95 } },
				{ step: "450", value: { l: 0.6681, c: 0.0105, h: 95 } },
			],
		}],
	},
};

test("contrast options begin with the surface and include current swatches", () => {
	let state = createPaletteState(palette);
	state = paletteReducer(state, {
		type: "edit",
		ref: { hue: "gray", step: "450" },
		value: { l: 0.7, c: 0.01, h: 95 },
	});
	let options = contrastOptions(state);
	expect(options[0]).toEqual({ id: "surface", label: "Page surface", value: { l: 1, c: 0, h: 0 } });
	expect(options.map(option => option.label)).toEqual(["Page surface", "Gray 400", "Gray 450"]);
	expect(options[2].value).toEqual({ l: 0.7, c: 0.01, h: 95 });
	expect(new Set(options.map(option => option.id)).size).toBe(options.length);
});

test("selected swatches expose a curve toggle and explain short rows", () => {
	let state = paletteReducer(createPaletteState(palette), {
		type: "select",
		ref: { hue: "gray", step: "450" },
	});
	let markup = renderToStaticMarkup(createElement(PaletteEditor, { state, dispatch() {} }));
	expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Edit gray ramp curve"/);
	expect(markup).toContain('class="cv-palette-popover-body"');
	expect(markup).toContain('data-curve-open="false"');
	expect(markup).not.toContain('aria-label="Ramp curve"');
	expect(markup).not.toContain("Needs at least two colors");

	let short = createPaletteState({
		themes: { light: [{ name: "solo", swatches: [{ step: "1", value: { l: 0.5, c: 0, h: 0 } }] }] },
	});
	short = paletteReducer(short, { type: "select", ref: { hue: "solo", step: "1" } });
	markup = renderToStaticMarkup(createElement(PaletteEditor, { state: short, dispatch() {} }));
	let button = markup.match(/<button[^>]*aria-label="Edit solo ramp curve"[^>]*>/)?.[0];
	expect(button).toContain('disabled=""');
	let describedBy = button?.match(/aria-describedby="([^"]+)"/)?.[1];
	expect(describedBy).toBeTruthy();
	expect(markup).toContain(`id="${describedBy}"`);
	expect(markup).toContain("Needs at least two colors");
});
