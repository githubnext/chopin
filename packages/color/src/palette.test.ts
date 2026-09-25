import { describe, expect, test } from "bun:test";

import {
	baseValue,
	changes,
	createPaletteState,
	currentValue,
	curveFor,
	gridRows,
	isEdited,
	paletteReducer,
	rowValues,
	sharedSteps,
	surface,
	tokenRows,
} from "./palette";
import { curveFrom } from "./curve";

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

describe("tokens", () => {
	let withTokens: Palette = {
		...palette,
		tokens: [
			{ name: "neutral-graphic", group: "neutral", ref: { hue: "gray", step: "450" } },
			{ name: "ghost", ref: { hue: "gone", step: "1" } },
		],
	};

	test("retargets, reports and resets a token after swatch changes", () => {
		let state = createPaletteState(withTokens);
		let to = { hue: "gray", step: "400" };
		state = paletteReducer(state, { type: "edit", ref: to, value: { l: 0.7, c: 0.01, h: 95 } });
		state = paletteReducer(state, { type: "retarget", token: "neutral-graphic", ref: to });
		expect(tokenRows(state)[0]).toMatchObject({
			ref: to,
			value: { l: 0.7, c: 0.01, h: 95 },
			retargeted: true,
		});
		expect(changes(state).at(-1)).toEqual({
			kind: "token",
			name: "neutral-graphic",
			before: { hue: "gray", step: "450" },
			after: to,
		});
		state = paletteReducer(state, {
			type: "retarget",
			token: "neutral-graphic",
			ref: { hue: "gray", step: "450" },
		});
		expect(tokenRows(state)[0].retargeted).toBe(false);
		expect(changes(state).some(change => change.kind === "token")).toBe(false);
	});

	test("resolves missing refs without throwing and ignores unknown tokens", () => {
		let state = createPaletteState(withTokens);
		expect(tokenRows(state)[1].value).toBeNull();
		expect(paletteReducer(state, { type: "retarget", token: "nope", ref: null })).toBe(state);
	});

	test("supports prototype-like token names and resetAll", () => {
		let custom: Palette = {
			...palette,
			tokens: [
				{ name: "__proto__", ref: { hue: "gray", step: "450" } },
				{ name: "toString", ref: { hue: "gray", step: "400" } },
			],
		};
		let state = createPaletteState(custom);
		expect(tokenRows(state).every(row => !row.retargeted)).toBe(true);
		state = paletteReducer(state, {
			type: "retarget",
			token: "__proto__",
			ref: { hue: "a/b", step: "1" },
		});
		state = paletteReducer(state, {
			type: "retarget",
			token: "toString",
			ref: { hue: "gray", step: "450" },
		});
		expect(JSON.stringify(state.retargets)).toBe(
			'{"__proto__":{"hue":"a/b","step":"1"},"toString":{"hue":"gray","step":"450"}}',
		);
		expect(changes(state).filter(change => change.kind === "token")).toHaveLength(2);
		state = paletteReducer(state, { type: "retarget", token: "__proto__", ref: null });
		expect(tokenRows(state)[0].retargeted).toBe(false);
		state = paletteReducer(state, { type: "resetAll" });
		expect(state.retargets).toEqual({});
		expect(changes(state)).toEqual([]);
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

	test("keeps prototype-like hue and step names as ordinary serialized edits", () => {
		let base = { l: 0.5, c: 0.1, h: 30 };
		let palette: Palette = {
			themes: { light: [{ name: "__proto__", swatches: [{ step: "__proto__", value: base }] }] },
		};
		let ref = { hue: "__proto__", step: "__proto__" };
		let value = { l: 0.6, c: 0.1, h: 30 };
		let state = paletteReducer(createPaletteState(palette), { type: "edit", ref, value });
		expect(currentValue(state, ref)).toEqual(value);
		expect(changes(state)).toEqual([{
			kind: "swatch",
			theme: "light",
			ref,
			before: base,
			after: value,
		}]);
		expect(JSON.stringify(state.edits.light)).toBe(
			'{"__proto__":{"__proto__":{"l":0.6,"c":0.1,"h":30}}}',
		);
		state = paletteReducer(state, { type: "reset", ref });
		expect(currentValue(state, ref)).toEqual(base);
		expect(changes(state)).toEqual([]);
		expect(JSON.stringify(state.edits.light)).toBe("{}");
	});

	test("does not mistake inherited toString for a swatch edit", () => {
		let base = { l: 0.5, c: 0.1, h: 30 };
		let palette: Palette = {
			themes: { light: [{ name: "__proto__", swatches: [{ step: "toString", value: base }] }] },
		};
		let ref = { hue: "__proto__", step: "toString" };
		let value = { l: 0.6, c: 0.1, h: 30 };
		let state = createPaletteState(palette);
		expect(currentValue(state, ref)).toEqual(base);
		expect(changes(state)).toEqual([]);
		state = paletteReducer(state, { type: "edit", ref, value });
		expect(currentValue(state, ref)).toEqual(value);
		expect(changes(state)).toEqual([{
			kind: "swatch",
			theme: "light",
			ref,
			before: base,
			after: value,
		}]);
		expect(JSON.stringify(state.edits.light)).toBe(
			'{"__proto__":{"toString":{"l":0.6,"c":0.1,"h":30}}}',
		);
		state = paletteReducer(state, { type: "reset", ref });
		expect(currentValue(state, ref)).toEqual(base);
		expect(changes(state)).toEqual([]);
		expect(JSON.stringify(state.edits.light)).toBe("{}");
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

	test("curves and resets a reversed dark row without changing the light row", () => {
		let reversed: Palette = {
			themes: {
				light: [palette.themes.light[0]],
				dark: [{
					name: "gray",
					swatches: [
						{ step: "400", value: { l: 0.2, c: 0.01, h: 95 } },
						{ step: "450", value: { l: 0.8, c: 0.01, h: 95 } },
					],
				}],
			},
		};
		let state = paletteReducer(createPaletteState(reversed), { type: "theme", theme: "dark" });
		let curve = {
			darkest: { l: 0.3, hueShift: 0, easing: "linear" as const },
			lightest: { l: 0.9, hueShift: 0, easing: "linear" as const },
		};
		state = paletteReducer(state, { type: "curve", hue: "gray", curve });
		expect(currentValue(state, { hue: "gray", step: "400" })!.l).toBeCloseTo(0.3, 6);
		expect(currentValue(state, { hue: "gray", step: "450" })!.l).toBeCloseTo(0.9, 6);
		expect(curveFor(state, "gray")).toEqual(curve);
		expect(changes(state).every(change => change.kind !== "swatch" || change.theme === "dark"))
			.toBe(true);
		state = paletteReducer(state, { type: "theme", theme: "light" });
		expect(currentValue(state, { hue: "gray", step: "400" })).toEqual(
			palette.themes.light[0].swatches[0].value,
		);
		state = paletteReducer(state, { type: "theme", theme: "dark" });
		expect(curveFor(state, "gray")).toEqual(curve);
		state = paletteReducer(state, { type: "resetRow", hue: "gray" });
		expect(changes(state)).toEqual([]);
		expect(curveFor(state, "gray")).toEqual(curveFrom(rowValues(state, "gray")!.base));
	});

	test("the curve action rewrites a row from its base and stores the settings", () => {
		let state = createPaletteState(palette);
		let curve = {
			darkest: { l: 0.6, hueShift: 0, easing: "linear" as const },
			lightest: { l: 0.8, hueShift: 0, easing: "linear" as const },
		};
		let once = paletteReducer(state, { type: "curve", hue: "gray", curve });
		let twice = paletteReducer(once, { type: "curve", hue: "gray", curve });
		expect(twice.edits).toEqual(once.edits);
		expect(currentValue(once, { hue: "gray", step: "400" })!.l).toBeCloseTo(0.8, 6);
		expect(curveFor(once, "gray")).toEqual(curve);
		let reset = paletteReducer(once, { type: "resetRow", hue: "gray" });
		expect(changes(reset)).toEqual([]);
		expect(curveFor(reset, "gray")).toEqual(curveFrom(rowValues(reset, "gray")!.base));
	});

	test("stores curves for prototype-like hue names", () => {
		let palette: Palette = {
			themes: {
				light: [{
					name: "__proto__",
					swatches: [
						{ step: "toString", value: { l: 0.9, c: 0.05, h: 30 } },
						{ step: "1", value: { l: 0.4, c: 0.1, h: 30 } },
					],
				}],
			},
		};
		let curve = {
			darkest: { l: 0.3, hueShift: 0, easing: "linear" as const },
			lightest: { l: 0.8, hueShift: 0, easing: "linear" as const },
		};
		let state = paletteReducer(createPaletteState(palette), {
			type: "curve",
			hue: "__proto__",
			curve,
		});
		expect(curveFor(state, "__proto__")).toEqual(curve);
		expect(JSON.stringify(state.curves.light)).toBe(
			'{"__proto__":{"darkest":{"l":0.3,"hueShift":0,"easing":"linear"},"lightest":{"l":0.8,"hueShift":0,"easing":"linear"}}}',
		);
		state = paletteReducer(state, { type: "resetRow", hue: "__proto__" });
		expect(JSON.stringify(state.curves.light)).toBe("{}");
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
