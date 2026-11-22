import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { contrast } from "./code-theme";
import { mermaidConfig, nightVariables } from "./mermaid-theme";

const THEME = readFileSync(new URL("../../../visuals/theme.css", import.meta.url), "utf8");

/** The shared theme's tokens at night: the day's, with the night's declared over them. */
function night(): (token: string) => string {
	let declared = new Map<string, string>();
	let start = THEME.indexOf(':root[data-theme="dark"] {');
	for (let part of [THEME.slice(0, start), THEME.slice(start)]) {
		for (let [, name, value] of part.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)) {
			declared.set(name!, value!.trim());
		}
	}
	let read = (token: string): string => {
		let value = declared.get(token);
		if (!value) throw new Error(`no ${token} in the shared theme`);
		let alias = /^var\((--color-[a-z0-9-]+)\)$/.exec(value);
		if (alias) return read(alias[1]!);
		let [, l, c, h] = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value)!.map(Number);
		return srgb(l!, c!, h!);
	};
	return read;
}

function srgb(l: number, c: number, h: number): string {
	let a = c * Math.cos((h * Math.PI) / 180);
	let b = c * Math.sin((h * Math.PI) / 180);
	let [lc, mc, sc] = [
		l + 0.3963377774 * a + 0.2158037573 * b,
		l - 0.1055613458 * a - 0.0638541728 * b,
		l - 0.0894841775 * a - 1.291485548 * b,
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

function channel(hex: string, at: number): number {
	return parseInt(hex.slice(at, at + 2), 16);
}

/** A reader that says which token each colour came from. */
function named(token: string): string {
	return `read(${token})`;
}

/** `colour` drawn at `opacity` over `ground`, as a pie slice is. */
function over(colour: string, ground: string, opacity: number): string {
	return "#"
		+ [1, 3, 5].map(at =>
			Math.round(channel(colour, at) * opacity + channel(ground, at) * (1 - opacity)).toString(16)
				.padStart(2, "0")
		).join("");
}

describe("Chopin's Mermaid theme", () => {
	it("draws by day exactly as it always has: neutral, with nothing laid over it", () => {
		let day = mermaidConfig("light", "Inter", () => {
			throw new Error("the day reads no colour from the page");
		});
		expect(day.theme).toBe("neutral");
		expect(day.themeVariables).toBeUndefined();
		expect(day.securityLevel).toBe("strict");
		expect(day.fontFamily).toBe("Inter");
	});

	it("draws at night over the same neutral, every colour a token of the page", () => {
		let config = mermaidConfig("dark", "Inter", named);
		expect(config.theme).toBe("neutral");
		let { darkMode, ...colours } = config.themeVariables as Record<string, unknown>;
		expect(darkMode).toBe(true);
		expect(Object.keys(colours).length).toBeGreaterThan(80);
		expect(
			Object.values(colours).filter(value => !/^read\(--color-[a-z0-9-]+\)$/.test(String(value))),
		)
			.toEqual([]);
		expect(colours.background).toBe("read(--color-page)");
		expect(colours.primaryTextColor).toBe("read(--color-text-primary)");
		expect(colours.edgeLabelBackground).toBe("read(--color-page)");
		let { theme: _day, themeVariables: _none, themeCSS: dayCSS, ...day } = mermaidConfig(
			"light",
			"Inter",
		);
		let { theme: _night, themeVariables: _colours, themeCSS: nightCSS, ...rest } = config;
		expect(rest).toEqual(day);
		expect(nightCSS!.startsWith(dayCSS!)).toBe(true);
	});

	// A colour written into the stylesheet would stay the same when the page's theme changes.
	it("takes every colour its stylesheet sets from the page's tokens", () => {
		let css = mermaidConfig("dark", "Inter", () => "#000000").themeCSS ?? "";
		let colours = [...css.matchAll(/(?:fill|stroke|color|background(?:-color)?)\s*:\s*([^;!}]+)/g)]
			.map(match => match[1]!.trim());
		expect(colours.length).toBeGreaterThan(20);
		expect(colours.filter(value => !/^var\(--color-[a-z0-9-]+\)$/.test(value))).toEqual([]);
	});

	it("puts words at 4.5:1 on every shape it fills at night", () => {
		let colours = nightVariables(night()) as Record<string, string>;
		let page = colours.background!;
		let pairs: [string, string, string][] = [
			["primaryTextColor", colours.primaryTextColor!, colours.mainBkg!],
			["primaryTextColor", colours.primaryTextColor!, page],
			["noteTextColor", colours.noteTextColor!, colours.noteBkgColor!],
			["labelTextColor", colours.labelTextColor!, colours.labelBoxBkgColor!],
			["actorTextColor", colours.actorTextColor!, colours.actorBkg!],
			["textColor", colours.textColor!, colours.rowEven!],
			["commitLabelColor", colours.commitLabelColor!, colours.commitLabelBackground!],
			["tagLabelColor", colours.tagLabelColor!, colours.tagLabelBackground!],
		];
		for (let index = 0; index < 12; index++) {
			pairs.push([
				`cScaleLabel${index}`,
				colours[`cScaleLabel${index}`]!,
				colours[`cScale${index}`]!,
			]);
			pairs.push([
				`pie${index + 1}`,
				colours.pieSectionTextColor!,
				over(colours[`pie${index + 1}`]!, page, 0.7),
			]);
		}
		for (let index = 0; index < 8; index++) {
			pairs.push([
				`gitBranchLabel${index}`,
				colours[`gitBranchLabel${index}`]!,
				colours[`git${index}`]!,
			]);
		}
		let below = pairs
			.map(([name, words, ground]) => ({ name, words, ground, ratio: contrast(words, ground) }))
			.filter(pair => pair.ratio < 4.5);
		expect(below).toEqual([]);
		// Lines and borders are seen on the page.
		for (let name of ["lineColor", "border1", "clusterBorder", "pieOuterStrokeColor"]) {
			expect(contrast(colours[name]!, page)).toBeGreaterThanOrEqual(3);
		}
	});
});
