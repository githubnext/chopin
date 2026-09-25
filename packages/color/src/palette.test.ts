import { describe, expect, test } from "bun:test";

import {
	baseValue,
	changes,
	createPaletteState,
	currentValue,
	gridRows,
	isEdited,
	paletteReducer,
	sharedSteps,
	surface,
} from "./palette";

import type { Palette } from "./palette";

let g450 = { l: 0.6681, c: 0.0105, h: 95 };
let palette: Palette = {
	themes: {
		light: [
			{
				name: "gray",
				swatches: [
					{ step: "400", value: { l: 0.74029, c: 0.00856, h: 95 } },
					{ step: "450", value: g450, source: "--color-gray-450" },
				],
			},
			{ name: "a/b", swatches: [{ step: "1", value: { l: 0.9, c: 0.05, h: 30 } }] },
		],
		dark: [{ name: "gray", swatches: [{ step: "400", value: { l: 0.3, c: 0.01, h: 95 } }] }],
	},
};
let ref = { hue: "gray", step: "450" };

describe("createPaletteState", () => {
	test("starts clean on the light theme", () => {
		let state = createPaletteState(palette);
		expect(state.theme).toBe("light");
		expect(state.selected).toBeNull();
		expect(changes(state)).toEqual([]);
	});

	test("rejects duplicate hues and duplicate steps loudly", () => {
		let hue = { name: "gray", swatches: [{ step: "1", value: g450 }] };
		expect(() => createPaletteState({ themes: { light: [hue, hue] } })).toThrow(
			'Duplicate hue "gray" in light theme',
		);
		expect(() =>
			createPaletteState({
				themes: { light: [{ name: "x", swatches: [hue.swatches[0], hue.swatches[0]] }] },
			})
		).toThrow('Duplicate step "1" in hue "x" (light theme)');
	});
});

describe("paletteReducer", () => {
	test("edits without touching the base", () => {
		let next = { l: 0.64, c: 0.0105, h: 95 };
		let state = paletteReducer(createPaletteState(palette), { type: "edit", ref, value: next });
		expect(currentValue(state, ref)).toEqual(next);
		expect(baseValue(state, ref)).toEqual(g450);
		expect(palette.themes.light[0].swatches[1].value).toEqual(g450);
		expect(isEdited(state, ref)).toBe(true);
	});

	test("an edit back to the base value removes the edit", () => {
		let state = createPaletteState(palette);
		state = paletteReducer(state, { type: "edit", ref, value: { l: 0.64, c: 0.0105, h: 95 } });
		state = paletteReducer(state, { type: "edit", ref, value: { ...g450, l: 0.668101 } });
		expect(isEdited(state, ref)).toBe(false);
		expect(state.edits.light).toEqual({});
	});

	test("keeps hue names with slashes distinct", () => {
		let state = paletteReducer(createPaletteState(palette), {
			type: "edit",
			ref: { hue: "a/b", step: "1" },
			value: { l: 0.8, c: 0.05, h: 30 },
		});
		expect(Object.keys(state.edits.light)).toEqual(["a/b"]);
	});

	test("ignores refs that do not exist and themes that are absent", () => {
		let state = createPaletteState(palette);
		expect(paletteReducer(state, { type: "edit", ref: { hue: "nope", step: "1" }, value: g450 }))
			.toBe(
				state,
			);
		let light = createPaletteState({ themes: { light: palette.themes.light } });
		expect(paletteReducer(light, { type: "theme", theme: "dark" })).toBe(light);
	});

	test("resets a swatch, a row, and everything", () => {
		let state = createPaletteState(palette);
		let other = { hue: "gray", step: "400" };
		state = paletteReducer(state, { type: "edit", ref, value: { ...g450, l: 0.6 } });
		state = paletteReducer(state, { type: "edit", ref: other, value: { ...g450, l: 0.7 } });
		expect(isEdited(paletteReducer(state, { type: "reset", ref }), ref)).toBe(false);
		expect(changes(paletteReducer(state, { type: "resetRow", hue: "gray" }))).toEqual([]);
		expect(changes(paletteReducer(state, { type: "resetAll" }))).toEqual([]);
	});

	test("keeps edits per theme", () => {
		let state = createPaletteState(palette);
		let dark = { hue: "gray", step: "400" };
		state = paletteReducer(state, { type: "theme", theme: "dark" });
		state = paletteReducer(state, { type: "edit", ref: dark, value: { l: 0.35, c: 0.01, h: 95 } });
		expect(changes(state)).toEqual([
			{
				kind: "swatch",
				theme: "dark",
				ref: dark,
				before: { l: 0.3, c: 0.01, h: 95 },
				after: { l: 0.35, c: 0.01, h: 95 },
			},
		]);
		state = paletteReducer(state, { type: "theme", theme: "light" });
		expect(isEdited(state, dark)).toBe(false);
	});
});

describe("selectors", () => {
	test("gridRows marks edited and selected cells", () => {
		let state = paletteReducer(createPaletteState(palette), { type: "select", ref });
		state = paletteReducer(state, { type: "edit", ref, value: { ...g450, l: 0.6 } });
		let cell = gridRows(state)[0].cells[1];
		expect(cell).toMatchObject({ step: "450", edited: true, selected: true });
	});

	test("sharedSteps only when every row has identical steps", () => {
		let state = createPaletteState(palette);
		expect(sharedSteps(gridRows(state))).toBeNull();
		let same = createPaletteState({
			themes: { light: [palette.themes.light[0], { ...palette.themes.light[0], name: "blue" }] },
		});
		expect(sharedSteps(gridRows(same))).toEqual(["400", "450"]);
	});

	test("surface defaults to white in light and a near-black in dark", () => {
		let state = createPaletteState(palette);
		expect(surface(state)).toEqual({ l: 1, c: 0, h: 0 });
		expect(surface(paletteReducer(state, { type: "theme", theme: "dark" }))).toEqual({
			l: 0.159,
			c: 0.006,
			h: 95,
		});
	});
});
