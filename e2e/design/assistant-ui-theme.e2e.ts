import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

import type { Page } from "@playwright/test";

/**
 * The theme is Chopin's, the proportions are assistant-ui's (assistant-ui-geometry.e2e.ts). Every colour
 * a copied element draws, in light and in dark, has to be a Chopin colour token, at that token's
 * opacity or less, and its text has to be Chopin's typeface. A raw assistant-ui colour (blue-500,
 * emerald-500, black) that survives resolves to no token and fails here, naming the element.
 * To add an element: put it on the plate, add its roots to `ROOTS`, and any state that draws a
 * colour of its own (hover, focus, open, checked) to `states`.
 */
const THEME = readFileSync(new URL("../../packages/visuals/theme.css", import.meta.url), "utf8");
/**
 * Chopin's colour tokens, from its own theme and nothing else. The roles assistant-ui's variables map
 * (`--color-accent`, `--color-ring`) are not among them: they are what is under test, and a role
 * mapped to a raw colour would otherwise vouch for itself.
 */
const TOKENS = [
	...new Set([
		...[...THEME.matchAll(/^\s*(--color-[\w-]+)\s*:/gm)].map(match => match[1]!),
		"--focus-ring-color",
	]),
];

const ROOTS = [
	'[data-slot="model-selector-trigger"]',
	'[data-slot="model-selector-content"]',
] as const;

type Colour = { r: number; g: number; b: number; a: number };
type Drawn = { where: string; property: string; value: string; colour: Colour };

/** Every colour drawn by the copies' elements right now, as sRGB and alpha. */
async function drawn(
	page: Page,
): Promise<{ drawn: Drawn[]; tokens: Record<string, Colour>; fonts: string[]; leaks: string[] }> {
	return page.evaluate(([roots, names]) => {
		let probe = document.createElement("span");
		document.body.append(probe);
		let read = (css: string) => {
			probe.style.color = "";
			probe.style.color = css;
			return getComputedStyle(probe).color;
		};
		let numbers = (text: string) => text.match(/-?\d*\.?\d+(?:e-?\d+)?/g)!.map(Number);
		let parse = (css: string): Colour => {
			// A colour from another space serializes as color(srgb 0..1 0..1 0..1); a legacy one as 0..255.
			let text = read(`rgb(from ${css} r g b / 1)`);
			let [r, g, b] = numbers(text).map(value => text.startsWith("color(") ? value * 255 : value);
			let alpha = numbers(read(`rgb(from ${css} 0 0 0 / alpha)`));
			return { r: r!, g: g!, b: b!, a: alpha.length > 3 ? alpha[3]! : 1 };
		};
		let tokens: Record<string, Colour> = {};
		for (let name of names!) tokens[name] = parse(`var(${name})`);
		let found: Drawn[] = [];
		let seen = new Set<Element>();
		let fonts: string[] = [];
		let leaks: string[] = [];
		let body = getComputedStyle(document.body).fontFamily;
		let describe = (element: Element) =>
			`${element.tagName.toLowerCase()}${
				element.getAttribute("data-slot") ? `[${element.getAttribute("data-slot")}]` : ""
			}${element.getAttribute("role") ? `[role=${element.getAttribute("role")}]` : ""}`;
		let add = (element: Element, property: string, value: string) => {
			if (!value || value === "none" || value === "currentcolor") return;
			found.push({ where: describe(element), property, value, colour: parse(value) });
		};
		for (let root of document.querySelectorAll(roots!.join(","))) {
			for (let element of [root, ...root.querySelectorAll("*")]) {
				if (seen.has(element)) continue;
				seen.add(element);
				let style = getComputedStyle(element);
				add(element, "color", style.color);
				add(element, "background-color", style.backgroundColor);
				for (let side of ["Top", "Right", "Bottom", "Left"] as const) {
					if (
						Number.parseFloat(style[`border${side}Width`]) > 0
						&& style[`border${side}Style`] !== "none"
					) {
						add(element, `border-${side.toLowerCase()}-color`, style[`border${side}Color`]);
						// A border left to preflight is drawn in the text colour: black rules between a copy's
						// parts, where assistant-ui draws its soft border role.
						if (style[`border${side}Color`] === style.color) {
							leaks.push(`${describe(element)} border-${side.toLowerCase()} is the text colour`);
						}
					}
				}
				if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
					add(element, "outline-color", style.outlineColor);
				}
				if (style.textDecorationLine !== "none") {
					add(element, "text-decoration-color", style.textDecorationColor);
				}
				if (element instanceof SVGElement) {
					add(element, "fill", style.fill);
					add(element, "stroke", style.stroke);
				}
				for (
					let shadow of style.boxShadow.match(
						/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\((?:[^()]|\([^()]*\))*\)/g,
					)
						?? []
				) add(element, "box-shadow", shadow);
				if (
					element.textContent
					&& [...element.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim())
				) {
					fonts.push(
						`${describe(element)}: ${style.fontFamily === body ? "Chopin" : style.fontFamily}`,
					);
				}
			}
		}
		probe.remove();
		return { drawn: found, tokens, fonts, leaks };
	}, [ROOTS, TOKENS] as const);
}

/** A colour is Chopin's when it is a token's, at its opacity or less; transparent draws nothing. */
function unthemed(result: Awaited<ReturnType<typeof drawn>>): string[] {
	let tokens = Object.entries(result.tokens);
	return result.drawn.filter(({ colour }) => {
		if (colour.a < 0.001) return false;
		return !tokens.some(([, token]) =>
			Math.abs(token.r - colour.r) <= 2.5 && Math.abs(token.g - colour.g) <= 2.5
			&& Math.abs(token.b - colour.b) <= 2.5 && colour.a <= token.a + 0.005
		);
	}).map(({ where, property, value }) => `${where} ${property}: ${value}`);
}

/** The states in which the copies draw a colour of their own; each is checked as it stands. */
async function states(page: Page, measure: (state: string) => Promise<void>) {
	// A colour mid-transition is a blend of two tokens: measure each state once it has settled.
	let check = async (state: string) => {
		await expect.poll(() => page.evaluate(() => document.getAnimations().length), {
			message: state,
		})
			.toBe(0);
		await measure(state);
	};
	let first = plate(page, "assistant-ui").getByRole("combobox").first();
	await first.scrollIntoViewIfNeeded();
	await check("rest");
	await first.hover();
	await check("trigger hover");
	await page.keyboard.press("Tab");
	await first.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	await check("trigger focus");
	await first.click();
	await expect(page.locator('[data-slot="model-selector-content"]')).toBeVisible();
	await expect.poll(() =>
		page.locator('[data-slot="model-selector-content"]').evaluate(node =>
			getComputedStyle(node).opacity
		)
	).toBe("1");
	await check("open");
	await page.locator('[data-slot="model-selector-item"]').nth(1).hover();
	await check("row hover");
	await page.locator('[data-slot="model-selector-effort"] [role="radio"]').nth(2).hover();
	await check("level hover");
}

for (let mode of ["light", "dark"] as const) {
	test(`every colour a copied element draws is a Chopin token, and its type is Chopin's, in ${mode}`, async ({ page }) => {
		if (mode === "dark") {
			await page.evaluate(() => document.documentElement.classList.add("dark"));
		}
		let checked = 0;
		await states(page, async state => {
			let result = await drawn(page);
			expect(result.drawn.length, `${state} draws colours`).toBeGreaterThan(10);
			expect(unthemed(result), `${state}, ${mode}: colours that are no Chopin token`).toEqual([]);
			expect(result.leaks, `${state}, ${mode}: borders drawn in the text colour`).toEqual([]);
			expect(
				result.fonts.filter(font => !font.endsWith(": Chopin")),
				`${state}, ${mode}: type outside Chopin's typeface`,
			).toEqual([]);
			checked += result.drawn.length;
		});
		expect(checked).toBeGreaterThan(300);
	});
}
