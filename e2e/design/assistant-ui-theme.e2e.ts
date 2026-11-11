import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

import type { Locator, Page } from "@playwright/test";

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
	'[data-slot="composer-menu"]',
	'[data-slot="directive-text-chip"]',
	'[data-slot="composer-attachments"]',
	'[data-slot="composer-voice"]',
	'[data-slot="composer-voice-button"]',
	'[data-slot="message-attachments"]',
] as const;

// The voice's dot pulses for as long as it listens, and a colour is read once nothing is moving.
test.use({ contextOptions: { reducedMotion: "reduce" } });

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
		// Chopin's own stack for technical words, which a copy's `font-mono` tag draws (the layer does
		// not restore a family, so the copy's is Chopin's, and the two are the same string).
		let mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
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
				// Only a shape paints: an icon's `svg` and `g` hold the default fill that its shapes override.
				if (element instanceof SVGGeometryElement) {
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
						`${describe(element)}: ${
							style.fontFamily === body
								? "Chopin"
								: style.fontFamily === mono
								? "Chopin mono"
								: style.fontFamily
						}`,
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
		// Moving, not merely in effect: an entrance that fills forwards stays listed once it has ended.
		await expect.poll(
			() =>
				page.evaluate(() =>
					document.getAnimations().filter(animation => animation.playState === "running").length
				),
			{ message: state },
		)
			.toBe(0);
		await measure(state);
	};
	let first = plate(page, "assistant-ui").getByRole("combobox").first();
	await first.scrollIntoViewIfNeeded();
	await check("rest");
	// What a hover colours in the files and the voice, before the selector opens over them.
	let message = plate(page, "assistant-ui").locator('[data-slot="message-attachments"] button')
		.first();
	await message.scrollIntoViewIfNeeded();
	await message.hover();
	await check("a sent file's hover");
	let voice = plate(page, "assistant-ui").locator('[data-slot="composer-voice-button"]').first();
	await voice.hover();
	await check("microphone hover");
	let remove = plate(page, "assistant-ui").locator('[data-slot="composer-attachment"] button')
		.first();
	await remove.hover();
	await check("a chip's remove hover");
	await first.scrollIntoViewIfNeeded();
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
				result.fonts.filter(font => !/: Chopin( mono)?$/.test(font)),
				`${state}, ${mode}: type outside Chopin's typeface`,
			).toEqual([]);
			checked += result.drawn.length;
		});
		expect(checked).toBeGreaterThan(300);
	});
}

/**
 * The theme comes from Chopin and the proportions from the message box (`assistant-ui-geometry` has
 * the proportions). Every colour the composer draws, light and dark, is a Chopin token or a mix of
 * them: its surface is the page, its edge Chopin's control edge, its toolbar the inset ground, its
 * send Chopin's primary, its font Chopin's. Chopin has no dark theme yet, so `.dark` reads the same
 * tokens and the two schemes draw the same colours.
 */

/** What a colour expression computes to, by asking the browser, so a token is exact. */
async function computed(page: Page, expression: string): Promise<string> {
	return page.evaluate(value => {
		let probe = document.createElement("i");
		probe.style.color = value;
		document.body.append(probe);
		let result = getComputedStyle(probe).color;
		probe.remove();
		return result;
	}, expression);
}

type Property = "backgroundColor" | "color" | "borderTopColor";

async function paint(element: Locator, property: Property): Promise<string> {
	return element.evaluate((node, name) => getComputedStyle(node)[name], property);
}

for (let name of ["light", "dark"] as const) {
	test(`the message box draws only Chopin's colours in ${name}: page, edge, inset, ink and primary from its tokens`, async ({ page }) => {
		await page.evaluate(
			dark => document.documentElement.classList.toggle("dark", dark),
			name === "dark",
		);
		let composer = plate(page, "chat").locator(".chat-composer").first();
		await composer.scrollIntoViewIfNeeded();
		let token = (value: string) => computed(page, `var(--color-${value})`);

		// The box is the page's surface with Chopin's control edge, and its edge darkens on focus.
		let box = composer.locator(".composer-surface");
		expect(await paint(box, "backgroundColor")).toBe(await token("page"));
		expect(await paint(box, "borderTopColor")).toBe(await token("control-edge"));
		await composer.getByRole("combobox", { name: "Message" }).focus();
		expect(await paint(box, "borderTopColor")).toBe(await token("text-tertiary"));

		// The toolbar is the inset ground with Chopin's edge for its divider, and its marks quiet ink.
		let toolbar = composer.getByRole("toolbar", { name: "Formatting" });
		expect(await paint(toolbar, "backgroundColor")).toBe(await token("inset"));
		expect(await paint(composer.locator(".composer-format-divider").first(), "backgroundColor"))
			.toBe(
				await token("edge"),
			);

		// Send is Chopin's primary with the page's colour on it, never black.
		let send = composer.locator("[data-send-stop]");
		await composer.getByRole("combobox", { name: "Message" }).fill("A message");
		expect(await paint(send, "backgroundColor")).toBe(await token("brand"));
		expect(await paint(send, "backgroundColor")).not.toBe("rgb(0, 0, 0)");
		expect(await paint(send, "color")).toBe(await token("page"));

		// Chopin's font family, and nothing in the box that is a colour Chopin does not have.
		let family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
		expect(family).toContain("Inter");
		expect(await box.evaluate(node => getComputedStyle(node).fontFamily)).toBe(family);
		let strangers = await composer.evaluate(root => {
			let canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
			let rgb = (value: string) => {
				canvas.clearRect(0, 0, 1, 1);
				canvas.fillStyle = "#000";
				canvas.fillStyle = value;
				canvas.fillRect(0, 0, 1, 1);
				return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).join(",");
			};
			// Every `--color-*` the page defines, as the root's own computed style lists them.
			let names = [...getComputedStyle(document.documentElement)].filter(property =>
				property.startsWith("--color-")
			);
			let known = new Set<string>([rgb("transparent")]);
			for (let property of names) {
				let probe = document.createElement("i");
				probe.style.color = `var(${property})`;
				document.body.append(probe);
				known.add(rgb(getComputedStyle(probe).color));
				probe.remove();
			}
			let found: string[] = [];
			for (let node of [root, ...root.querySelectorAll(".composer-surface, .composer-surface *")]) {
				let style = getComputedStyle(node);
				for (let property of ["color", "backgroundColor", "borderTopColor"] as const) {
					let value = style[property];
					if (value === "transparent" || /^rgba\(\d+, \d+, \d+, 0\)$/.test(value)) continue;
					if (!known.has(rgb(value))) {
						found.push(`${property} ${value} on ${node.tagName.toLowerCase()}`);
					}
				}
			}
			return found;
		});
		expect(strangers).toEqual([]);
	});
}
