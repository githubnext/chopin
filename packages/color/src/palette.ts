import { sameColor } from "./oklch";
import { curveFrom, rampCurve } from "./curve";

import type { Curve } from "./curve";
import type { Oklch } from "./oklch";

export type Theme = "light" | "dark";
export type SwatchRef = { hue: string; step: string };
export type Swatch = { step: string; value: Oklch; source?: string };
export type Hue = { name: string; swatches: Swatch[] };
export type Token = { name: string; group?: string; ref: SwatchRef; source?: string };
export type Palette = {
	themes: { light: Hue[]; dark?: Hue[] };
	surfaces?: Partial<Record<Theme, Oklch>>;
	tokens?: Token[];
};
export type Edits = Record<string, Record<string, Oklch>>;
export type PaletteState = {
	palette: Palette;
	theme: Theme;
	edits: Record<Theme, Edits>;
	curves: Record<Theme, Record<string, Curve>>;
	retargets: Record<string, SwatchRef>;
	selected: SwatchRef | null;
};
export type PaletteAction =
	| { type: "select"; ref: SwatchRef | null }
	| { type: "edit"; ref: SwatchRef; value: Oklch }
	| { type: "reset"; ref: SwatchRef }
	| { type: "resetRow"; hue: string }
	| { type: "resetAll" }
	| { type: "curve"; hue: string; curve: Curve }
	| { type: "retarget"; token: string; ref: SwatchRef | null }
	| { type: "theme"; theme: Theme };
export type SwatchChange = {
	kind: "swatch";
	theme: Theme;
	ref: SwatchRef;
	before: Oklch;
	after: Oklch;
};
export type TokenChange = { kind: "token"; name: string; before: SwatchRef; after: SwatchRef };
export type Change = SwatchChange | TokenChange;
export type TokenRow = {
	name: string;
	group?: string;
	ref: SwatchRef;
	original: SwatchRef;
	value: Oklch | null;
	retargeted: boolean;
};
export type GridCell = {
	ref: SwatchRef;
	step: string;
	value: Oklch;
	edited: boolean;
	selected: boolean;
};
export type GridRow = { name: string; cells: GridCell[] };

const DEFAULT_SURFACES: Record<Theme, Oklch> = {
	light: { l: 1, c: 0, h: 0 },
	dark: { l: 0.159, c: 0.006, h: 95 },
};

function validate(hues: readonly Hue[], theme: Theme) {
	let names = new Set<string>();
	for (let hue of hues) {
		if (names.has(hue.name)) throw new Error(`Duplicate hue "${hue.name}" in ${theme} theme`);
		names.add(hue.name);
		let steps = new Set<string>();
		for (let swatch of hue.swatches) {
			if (steps.has(swatch.step)) {
				throw new Error(`Duplicate step "${swatch.step}" in hue "${hue.name}" (${theme} theme)`);
			}
			steps.add(swatch.step);
		}
	}
}

function emptyEdits(): Edits {
	return Object.create(null) as Edits;
}

function copyEdits(edits: Edits): Edits {
	return Object.assign(emptyEdits(), edits);
}

function copySteps(steps: Record<string, Oklch>): Record<string, Oklch> {
	return Object.assign(Object.create(null) as Record<string, Oklch>, steps);
}

function emptyCurves(): Record<string, Curve> {
	return Object.create(null) as Record<string, Curve>;
}

function emptyRetargets(): Record<string, SwatchRef> {
	return Object.create(null) as Record<string, SwatchRef>;
}

function copyCurves(curves: Record<string, Curve>): Record<string, Curve> {
	return Object.assign(emptyCurves(), curves);
}

function curveValue(curves: Record<string, Curve>, hue: string): Curve | undefined {
	return Object.hasOwn(curves, hue) ? curves[hue] : undefined;
}

function editSteps(edits: Edits | undefined, hue: string): Record<string, Oklch> | undefined {
	return edits && Object.hasOwn(edits, hue) ? edits[hue] : undefined;
}

function editValue(steps: Record<string, Oklch> | undefined, step: string): Oklch | undefined {
	return steps && Object.hasOwn(steps, step) ? steps[step] : undefined;
}

export function createPaletteState(palette: Palette): PaletteState {
	validate(palette.themes.light, "light");
	if (palette.themes.dark) validate(palette.themes.dark, "dark");
	return {
		palette,
		theme: "light",
		edits: { light: emptyEdits(), dark: emptyEdits() },
		curves: { light: emptyCurves(), dark: emptyCurves() },
		retargets: emptyRetargets(),
		selected: null,
	};
}

function huesOf(palette: Palette, theme: Theme): Hue[] {
	return (theme === "dark" ? palette.themes.dark : palette.themes.light) ?? [];
}

export function activeHues(state: PaletteState): Hue[] {
	return huesOf(state.palette, state.theme);
}

function findSwatch(hues: readonly Hue[], ref: SwatchRef): Swatch | undefined {
	return hues.find(hue => hue.name === ref.hue)?.swatches.find(swatch => swatch.step === ref.step);
}

function withEdit(edits: Edits, ref: SwatchRef, value: Oklch | undefined): Edits {
	let steps = copySteps(editSteps(edits, ref.hue) ?? Object.create(null));
	if (value) steps[ref.step] = value;
	else delete steps[ref.step];
	let next = copyEdits(edits);
	if (Object.keys(steps).length) next[ref.hue] = steps;
	else delete next[ref.hue];
	return next;
}

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
	switch (action.type) {
		case "select":
			return { ...state, selected: action.ref };
		case "edit": {
			let base = findSwatch(activeHues(state), action.ref);
			if (!base) return state;
			let value = sameColor(action.value, base.value) ? undefined : action.value;
			let edits = withEdit(state.edits[state.theme], action.ref, value);
			return { ...state, edits: { ...state.edits, [state.theme]: edits } };
		}
		case "reset": {
			let edits = withEdit(state.edits[state.theme], action.ref, undefined);
			return { ...state, edits: { ...state.edits, [state.theme]: edits } };
		}
		case "resetRow": {
			let edits = copyEdits(state.edits[state.theme]);
			let curves = copyCurves(state.curves[state.theme]);
			delete edits[action.hue];
			delete curves[action.hue];
			return {
				...state,
				edits: { ...state.edits, [state.theme]: edits },
				curves: { ...state.curves, [state.theme]: curves },
			};
		}
		case "resetAll":
			return {
				...state,
				edits: { light: emptyEdits(), dark: emptyEdits() },
				curves: { light: emptyCurves(), dark: emptyCurves() },
				retargets: emptyRetargets(),
			};
		case "curve": {
			let row = rowValues(state, action.hue);
			if (!row) return state;
			let edits = state.edits[state.theme];
			for (let [index, value] of rampCurve(row.base, action.curve).entries()) {
				let ref = { hue: action.hue, step: row.steps[index] };
				edits = withEdit(edits, ref, sameColor(value, row.base[index]) ? undefined : value);
			}
			let curves = copyCurves(state.curves[state.theme]);
			curves[action.hue] = action.curve;
			return {
				...state,
				edits: { ...state.edits, [state.theme]: edits },
				curves: { ...state.curves, [state.theme]: curves },
			};
		}
		case "theme":
			if (action.theme === state.theme || !huesOf(state.palette, action.theme).length) return state;
			return { ...state, theme: action.theme, selected: null };
		case "retarget": {
			let token = state.palette.tokens?.find(candidate => candidate.name === action.token);
			if (!token) return state;
			let next = Object.assign(emptyRetargets(), state.retargets);
			if (
				!action.ref
				|| (action.ref.hue === token.ref.hue && action.ref.step === token.ref.step)
			) delete next[action.token];
			else next[action.token] = action.ref;
			return { ...state, retargets: next };
		}
	}
}

export function baseValue(state: PaletteState, ref: SwatchRef): Oklch | null {
	return findSwatch(activeHues(state), ref)?.value ?? null;
}

export function currentValue(state: PaletteState, ref: SwatchRef): Oklch | null {
	return editValue(editSteps(state.edits[state.theme], ref.hue), ref.step) ?? baseValue(state, ref);
}

export function rowValues(
	state: PaletteState,
	hue: string,
): { base: Oklch[]; current: Oklch[]; steps: string[] } | null {
	let row = activeHues(state).find(candidate => candidate.name === hue);
	if (!row) return null;
	let steps = row.swatches.map(swatch => swatch.step);
	let base = row.swatches.map(swatch => swatch.value);
	return { base, current: steps.map(step => currentValue(state, { hue, step })!), steps };
}

export function curveFor(state: PaletteState, hue: string): Curve | null {
	let row = rowValues(state, hue);
	if (!row) return null;
	return curveValue(state.curves[state.theme], hue) ?? curveFrom(row.base);
}

export function isEdited(state: PaletteState, ref: SwatchRef): boolean {
	return editValue(editSteps(state.edits[state.theme], ref.hue), ref.step) !== undefined;
}

export function surface(state: PaletteState): Oklch {
	return state.palette.surfaces?.[state.theme] ?? DEFAULT_SURFACES[state.theme];
}

export function gridRows(state: PaletteState): GridRow[] {
	return activeHues(state).map(hue => ({
		name: hue.name,
		cells: hue.swatches.map(swatch => {
			let ref = { hue: hue.name, step: swatch.step };
			return {
				ref,
				step: swatch.step,
				value: currentValue(state, ref)!,
				edited: isEdited(state, ref),
				selected: state.selected?.hue === hue.name && state.selected.step === swatch.step,
			};
		}),
	}));
}

export function tokenRows(state: PaletteState): TokenRow[] {
	return (state.palette.tokens ?? []).map(token => {
		let retargeted = Object.hasOwn(state.retargets, token.name);
		let ref = retargeted ? state.retargets[token.name] : token.ref;
		return {
			name: token.name,
			group: token.group,
			ref,
			original: token.ref,
			value: currentValue(state, ref),
			retargeted,
		};
	});
}

export function sharedSteps(rows: readonly GridRow[]): string[] | null {
	if (!rows.length) return null;
	let steps = rows[0].cells.map(cell => cell.step);
	let same = rows.every(
		row =>
			row.cells.length === steps.length
			&& row.cells.every((cell, index) => cell.step === steps[index]),
	);
	return same && steps.length ? steps : null;
}

export function changes(state: PaletteState): Change[] {
	let found: Change[] = [];
	for (let theme of ["light", "dark"] as const) {
		for (let hue of huesOf(state.palette, theme)) {
			for (let swatch of hue.swatches) {
				let after = editValue(editSteps(state.edits[theme], hue.name), swatch.step);
				if (after) {
					found.push({
						kind: "swatch",
						theme,
						ref: { hue: hue.name, step: swatch.step },
						before: swatch.value,
						after,
					});
				}
			}
		}
	}
	for (let token of state.palette.tokens ?? []) {
		if (!Object.hasOwn(state.retargets, token.name)) continue;
		found.push({
			kind: "token",
			name: token.name,
			before: token.ref,
			after: state.retargets[token.name],
		});
	}
	return found;
}
