/**
 * Chopin's code palettes: pierre-light and pierre-dark, each on the page it is drawn on, with every
 * foreground moved away from that page, in its own hue and chroma, only as far as WCAG AA asks
 * (4.5:1 for words): darker on the light page, lighter on the dark one. The maintainer chose AA
 * everywhere on 11 November 2026, so the code and diff palette is no longer an exception; this
 * keeps pierre's colours and moves only their lightness.
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
};

export const CODE_THEMES = {
	light: { name: "chopin-light", base: "pierre-light", background: "#ffffff" },
	dark: { name: "chopin-dark", base: "pierre-dark", background: "#21201d" },
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

/**
 * The colour, or the same hue and chroma moved away from `background` in OKLCH steps of 0.0005,
 * darker on a light one and lighter on a dark one, until it reaches `ratio` on it. An alpha suffix
 * (`#rrggbbaa`) is kept as it is: a translucent colour is a wash, not words.
 */
export function legible(colour: string, background: string, ratio = CODE_TEXT_RATIO): string {
	if (!/^#[0-9a-f]{6}$/i.test(colour)) return colour;
	if (contrast(colour, background) >= ratio) return colour;
	let [lightness, a, b] = toOklab(channels(colour));
	if (light(background)) {
		for (let next = lightness; next > 0; next -= 0.0005) {
			let candidate = toHex(next, a, b);
			if (contrast(candidate, background) >= ratio) return candidate;
		}
		return "#000000";
	}
	for (let next = lightness; next < 1; next += 0.0005) {
		let candidate = toHex(next, a, b);
		if (contrast(candidate, background) >= ratio) return candidate;
	}
	return "#ffffff";
}

/** A pierre palette on Chopin's page, its words and change marks at AA on it. */
export function accessibleTheme<T extends Theme>(theme: T, { name, background }: CodeTheme): T {
	let fix = (colour: string | undefined) =>
		colour === undefined ? colour : legible(colour, background);
	let rule = (entry: Rule): Rule =>
		entry.settings?.foreground
			? { ...entry, settings: { ...entry.settings, foreground: fix(entry.settings.foreground) } }
			: entry;
	let colors = Object.fromEntries(
		Object.entries(theme.colors ?? {}).map((
			[key, value],
		) => [key, /foreground$/i.test(key) ? fix(value)! : value]),
	);
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
