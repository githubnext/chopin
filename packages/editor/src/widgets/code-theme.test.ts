import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveTheme } from "@pierre/diffs";

import { accessibleTheme, CODE_THEMES, contrast, legible } from "./code-theme";

import type { CodeTheme } from "./code-theme";

const HEX = /^#[0-9a-f]{6}$/i;

/** Every word and change mark the palette draws, as the renderer reads them. */
function foregrounds(theme: Awaited<ReturnType<typeof resolveTheme>>): string[] {
	return [
		theme.fg,
		...Object.entries(theme.colors ?? {})
			.filter(([key, value]) => /foreground$/i.test(key) && HEX.test(value))
			.map(([, value]) => value),
		...(theme.settings ?? []).flatMap(rule => rule.settings?.foreground ?? []),
	].filter(colour => HEX.test(colour));
}

function lightness(hex: string): number {
	let [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(value =>
		value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
	) as [number, number, number];
	return Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) * 0.2104542553
		+ Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) * 0.793617785
		- Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) * 0.0040720468;
}

describe("the code palettes", () => {
	// Measured as the browser draws them: after rounding to 8 bits a channel.
	it("darkens pierre-light's colours in their own hue only as far as 4.5:1", () => {
		expect(legible("#08c0ef", "#ffffff")).toBe("#007fac");
		expect(legible("#d5901c", "#ffffff")).toBe("#aa6700");
		expect(legible("#1ca1c7", "#ffffff")).toBe("#0080a5");
		expect(legible("#18a46c", "#ffffff")).toBe("#008853");
		expect(legible("#d47628", "#ffffff")).toBe("#b95e00");
		// Already AA, or a translucent wash: left as pierre drew it.
		expect(legible("#d32a61", "#ffffff")).toBe("#d32a61");
		expect(legible("#18a46c33", "#ffffff")).toBe("#18a46c33");
	});

	it("lightens a colour on a dark page, never darkens it", () => {
		let page = CODE_THEMES.dark.background;
		for (let colour of ["#636363", "#737373", "#7b43f8", "#1a85d4"]) {
			let fixed = legible(colour, page);
			expect(contrast(fixed, page)).toBeGreaterThanOrEqual(4.5);
			expect(lightness(fixed)).toBeGreaterThan(lightness(colour));
		}
		// Already AA on the dark page: left as pierre-dark drew it.
		expect(legible("#ff678d", page)).toBe("#ff678d");
	});

	for (let [mode, palette] of Object.entries(CODE_THEMES) as [string, CodeTheme][]) {
		it(`puts every word and change mark of the ${mode} palette at AA on the ${mode} page`, async () => {
			let base = await resolveTheme(palette.base);
			let theme = accessibleTheme(base, palette);
			expect(theme.name).toBe(palette.name);
			expect(theme.bg).toBe(palette.background);
			expect(theme.colors?.["editor.background"]).toBe(palette.background);
			let drawn = foregrounds(theme);
			expect(drawn.length).toBeGreaterThan(100);
			expect(drawn.filter(colour => contrast(colour, palette.background) < 4.5)).toEqual([]);
			// Only what fell short moved, and only in lightness, away from the page.
			let before = foregrounds(base);
			expect(drawn.length).toBe(before.length);
			for (let [index, colour] of before.entries()) {
				if (contrast(colour, palette.background) >= 4.5) expect(drawn[index]).toBe(colour);
				else if (mode === "light") expect(lightness(drawn[index]!)).toBeLessThan(lightness(colour));
				else expect(lightness(drawn[index]!)).toBeGreaterThan(lightness(colour));
			}
		});
	}

	it("keeps the light palette on white, as it was before there was a dark one", () => {
		expect(CODE_THEMES.light).toEqual({
			name: "chopin-light",
			base: "pierre-light",
			background: "#ffffff",
		});
	});

	// The palettes are made at AA against these pages, so a page that changes makes them again.
	it("is drawn on each theme's own page, as the shared theme sets it", () => {
		let theme = readFileSync(new URL("../../../visuals/theme.css", import.meta.url), "utf8");
		let night = theme.slice(theme.indexOf(':root[data-theme="dark"] {'));
		expect(night.length).toBeLessThan(theme.length);
		expect(page(theme)).toBe(CODE_THEMES.light.background);
		expect(page(night)).toBe(CODE_THEMES.dark.background);
	});
});

/** The first `--color-page` in `css`, an `oklch()` colour, as the browser draws it in sRGB. */
function page(css: string): string {
	let [, l, c, h] = /--color-page:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(css)!.map(Number);
	let a = c! * Math.cos((h! * Math.PI) / 180);
	let b = c! * Math.sin((h! * Math.PI) / 180);
	let [lc, mc, sc] = [
		l! + 0.3963377774 * a + 0.2158037573 * b,
		l! - 0.1055613458 * a - 0.0638541728 * b,
		l! - 0.0894841775 * a - 1.291485548 * b,
	].map(value => value ** 3) as [number, number, number];
	return "#" + [
		4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
		-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
		-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
	].map(value => {
		let v = Math.max(0, Math.min(1, value));
		v = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
		return Math.round(v * 255).toString(16).padStart(2, "0");
	}).join("");
}
