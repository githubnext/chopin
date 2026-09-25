import { expect, test } from "bun:test";
import { createPaletteState, paletteReducer } from "@chopin/color";

import { contrastOptions } from "./palette-editor";

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
