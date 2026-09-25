import { sameColor } from "./oklch";

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
	selected: SwatchRef | null;
};
export type PaletteAction =
	| { type: "select"; ref: SwatchRef | null }
	| { type: "edit"; ref: SwatchRef; value: Oklch }
	| { type: "reset"; ref: SwatchRef }
	| { type: "resetRow"; hue: string }
	| { type: "resetAll" }
	| { type: "theme"; theme: Theme };
export type SwatchChange = {
	kind: "swatch";
	theme: Theme;
	ref: SwatchRef;
	before: Oklch;
	after: Oklch;
};
export type Change = SwatchChange;
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

export function createPaletteState(palette: Palette): PaletteState {
	validate(palette.themes.light, "light");
	if (palette.themes.dark) validate(palette.themes.dark, "dark");
	return { palette, theme: "light", edits: { light: {}, dark: {} }, selected: null };
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
	let steps = { ...edits[ref.hue] };
	if (value) steps[ref.step] = value;
	else delete steps[ref.step];
	let next = { ...edits };
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
			let edits = { ...state.edits[state.theme] };
			delete edits[action.hue];
			return { ...state, edits: { ...state.edits, [state.theme]: edits } };
		}
		case "resetAll":
			return { ...state, edits: { light: {}, dark: {} } };
		case "theme":
			if (action.theme === state.theme || !huesOf(state.palette, action.theme).length) return state;
			return { ...state, theme: action.theme, selected: null };
	}
}

export function baseValue(state: PaletteState, ref: SwatchRef): Oklch | null {
	return findSwatch(activeHues(state), ref)?.value ?? null;
}

export function currentValue(state: PaletteState, ref: SwatchRef): Oklch | null {
	return state.edits[state.theme][ref.hue]?.[ref.step] ?? baseValue(state, ref);
}

export function isEdited(state: PaletteState, ref: SwatchRef): boolean {
	return Boolean(state.edits[state.theme][ref.hue]?.[ref.step]);
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
				let after = state.edits[theme][hue.name]?.[swatch.step];
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
	return found;
}
