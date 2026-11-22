/**
 * Chopin's code palettes: pierre-light and pierre-dark, each on the page it is drawn on, with every
 * foreground moved away from that page, in its own hue and chroma, only as far as WCAG AA asks
 * (4.5:1 for words): darker on the light page, lighter on the dark one. A patch's words are read on
 * its added and removed lines too, which the renderer tints from the palette's own change colours,
 * so a word reaches AA on every one of those as well. The maintainer chose AA everywhere on 11
 * November 2026, so the code and diff palette is no longer an exception; this keeps pierre's
 * colours and moves only their lightness.
 */

export type CodeTheme = {
	/** The name the renderer knows the palette by. */
	name: string;
	/** The pierre palette it is made from. */
	base: "pierre-light" | "pierre-dark";
	/**
	 * The page code is drawn on, `--color-page` in `packages/visuals/theme.css`: a diff's preview
	 * fills its block with it, so pierre-dark's near-black never shows through the warm page.
	 */
	background: string;
	/**
	 * How the renderer tints a changed line and the changed words in it (`@pierre/diffs`'
	 * stylesheet): the line is the page with this much of the change colour mixed in, in Lab, and the
	 * words are the change colour at this opacity over the line.
	 */
	tint: { line: number; words: number };
};

export const CODE_THEMES = {
	light: {
		name: "chopin-light",
		base: "pierre-light",
		background: "#ffffff",
		tint: { line: 0.12, words: 0.15 },
	},
	dark: {
		name: "chopin-dark",
		base: "pierre-dark",
		background: "#21201d",
		tint: { line: 0.2, words: 0.2 },
	},
} as const satisfies Record<"light" | "dark", CodeTheme>;

/** The ratio words need on the code's background. */
export const CODE_TEXT_RATIO = 4.5;

type Rule = { settings?: { foreground?: string } };

type Theme = {
	name?: string;
	colors?: Record<string, string>;
	settings?: Rule[];
	tokenColors?: Rule[];
	semanticTokenColors?: Record<string, string | { foreground?: string }>;
	fg?: string;
	bg?: string;
};

function linear(value: number) {
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function gamma(value: number) {
	let clamped = Math.max(0, Math.min(1, value));
	return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function channels(hex: string): [number, number, number] {
	return [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]) {
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: string, b: string): number {
	let [high, low] = [luminance(channels(a)), luminance(channels(b))].sort((x, y) => y - x);
	return (high! + 0.05) / (low! + 0.05);
}

function toOklab([r, g, b]: [number, number, number]) {
	let [lr, lg, lb] = [linear(r), linear(g), linear(b)];
	let l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	let m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	let s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	] as const;
}

function toHex(lightness: number, a: number, b: number): string {
	let l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return "#" + [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	].map(value => Math.round(gamma(value) * 255).toString(16).padStart(2, "0")).join("");
}

/** Whether words reach more contrast in black than in white on `background`. */
function light(background: string) {
	return contrast(background, "#000000") >= contrast(background, "#ffffff");
}

/** The least contrast `colour` has on any of `backgrounds`. */
function least(colour: string, backgrounds: readonly string[]) {
	return Math.min(...backgrounds.map(background => contrast(colour, background)));
}

/**
 * The colour, or the same hue and chroma moved away from the background in OKLCH steps of 0.0005,
 * darker on a light one and lighter on a dark one, until it reaches `ratio` on it, or on every one
 * of several (the first decides the direction). An alpha suffix (`#rrggbbaa`) is kept as it is: a
 * translucent colour is a wash, not words.
 */
export function legible(
	colour: string,
	background: string | readonly string[],
	ratio = CODE_TEXT_RATIO,
): string {
	let backgrounds = typeof background === "string" ? [background] : background;
	if (!/^#[0-9a-f]{6}$/i.test(colour)) return colour;
	if (least(colour, backgrounds) >= ratio) return colour;
	let [lightness, a, b] = toOklab(channels(colour));
	if (light(backgrounds[0]!)) {
		for (let next = lightness; next > 0; next -= 0.0005) {
			let candidate = toHex(next, a, b);
			if (least(candidate, backgrounds) >= ratio) return candidate;
		}
		return "#000000";
	}
	for (let next = lightness; next < 1; next += 0.0005) {
		let candidate = toHex(next, a, b);
		if (least(candidate, backgrounds) >= ratio) return candidate;
	}
	return "#ffffff";
}

const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

function labF(t: number) {
	return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function labInverse(t: number) {
	return t ** 3 > EPSILON ? t ** 3 : (116 * t - 16) / KAPPA;
}

/** sRGB to CIE Lab (D50), the space CSS `color-mix(in lab, …)` mixes in. */
function toLab(hex: string): [number, number, number] {
	let [r, g, b] = channels(hex).map(linear) as [number, number, number];
	let x65 = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
	let y65 = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	let z65 = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
	let x = (1.0479298208405488 * x65 + 0.022946793341019088 * y65 - 0.05019222954313557 * z65)
		/ 0.9642956764295677;
	let y = 0.029627815688159344 * x65 + 0.990434484573249 * y65 - 0.01707382502938514 * z65;
	let z = (-0.009243058152591178 * x65 + 0.015055144896577895 * y65 + 0.752131635446103 * z65)
		/ 0.8251046025104602;
	return [116 * labF(y) - 16, 500 * (labF(x) - labF(y)), 200 * (labF(y) - labF(z))];
}

/** CIE Lab (D50) to sRGB channels from 0 to 1, unrounded, as the browser holds a mixed colour. */
function fromLab([l, a, b]: [number, number, number]): [number, number, number] {
	let fy = (l + 16) / 116;
	let fx = a / 500 + fy;
	let fz = fy - b / 200;
	let x = labInverse(fx) * 0.9642956764295677;
	let y = l > 8 ? fy ** 3 : l / KAPPA;
	let z = labInverse(fz) * 0.8251046025104602;
	let x65 = 0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z;
	let y65 = -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z;
	let z65 = 0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z;
	return [
		3.2404542 * x65 - 1.5371385 * y65 - 0.4985314 * z65,
		-0.969266 * x65 + 1.8760108 * y65 + 0.041556 * z65,
		0.0556434 * x65 - 0.2040259 * y65 + 1.0572252 * z65,
	].map(gamma) as [number, number, number];
}

function hex(rgb: readonly number[]): string {
	return "#" + rgb.map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
}

/** `color-mix(in lab, base, tint amount)`. */
function mix(base: string, tint: string, amount: number): [number, number, number] {
	let [from, to] = [toLab(base), toLab(tint)];
	return fromLab(
		from.map((value, at) => value + (to[at]! - value) * amount) as [number, number, number],
	);
}

/** `tint` at `opacity` over `base`, as the browser composites it. */
function over(base: readonly number[], tint: string, opacity: number): string {
	let top = channels(tint);
	return hex(base.map((value, at) => value + (top[at]! - value) * opacity));
}

/**
 * Everything a patch's words are drawn on: the page, and each changed line and changed word, which
 * the renderer tints from the palette's addition and deletion colours as `@pierre/diffs` reads them.
 */
export function changeGrounds(
	colors: Record<string, string>,
	{ background, tint }: Pick<CodeTheme, "background" | "tint">,
): string[] {
	let grounds = [background];
	for (
		let change of [
			colors["gitDecoration.addedResourceForeground"] ?? colors["terminal.ansiGreen"],
			colors["gitDecoration.deletedResourceForeground"] ?? colors["terminal.ansiRed"],
		]
	) {
		if (!change || !/^#[0-9a-f]{6}$/i.test(change)) continue;
		let line = mix(background, change, tint.line);
		grounds.push(hex(line), over(line, change, tint.words));
	}
	return grounds;
}

/** A pierre palette on Chopin's page, its words and change marks at AA on it and on changed lines. */
export function accessibleTheme<T extends Theme>(theme: T, palette: CodeTheme): T {
	let { name, background } = palette;
	// The change colours are read on the page; they then tint the lines the words are read on.
	let colors = Object.fromEntries(
		Object.entries(theme.colors ?? {}).map((
			[key, value],
		) => [key, /foreground$/i.test(key) ? legible(value, background) : value]),
	);
	let grounds = changeGrounds(colors, palette);
	let fix = (colour: string | undefined) =>
		colour === undefined ? colour : legible(colour, grounds);
	let rule = (entry: Rule): Rule =>
		entry.settings?.foreground
			? { ...entry, settings: { ...entry.settings, foreground: fix(entry.settings.foreground) } }
			: entry;
	return {
		...theme,
		name,
		colors: { ...colors, "editor.background": background },
		bg: background,
		fg: fix(theme.fg),
		// A resolved theme keeps its rules as `settings`, a registration as `tokenColors`.
		settings: theme.settings?.map(rule),
		tokenColors: theme.tokenColors?.map(rule),
		semanticTokenColors: theme.semanticTokenColors && Object.fromEntries(
			Object.entries(theme.semanticTokenColors).map(([key, value]) => [
				key,
				typeof value === "string"
					? fix(value)!
					: { ...value, foreground: fix(value.foreground) },
			]),
		),
	};
}
