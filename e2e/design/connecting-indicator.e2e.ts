import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

import type { Locator, Page } from "@playwright/test";

/**
 * The one connecting indicator, as the conversation plate draws it with the production components:
 * the offline bar reconnecting the room, and the machine button's badge while its Planner starts.
 * Its geometry holds the place of what it replaced and never moves, its colours are Chopin's, and
 * reduced motion holds it still as an ellipsis.
 */
const banner = (page: Page) =>
	plate(page, "chat").locator('[data-connection-banner][data-phase="reconnecting"]');
const badge = (page: Page) =>
	plate(page, "chat").locator('.machine-glyph-dot[data-planner="starting"]');
const dots = (within: Locator) => within.locator("[data-connecting]");

function indicators(page: Page): [string, Locator][] {
	return [
		["reconnecting bar", dots(banner(page))],
		["machine button badge", dots(badge(page))],
	];
}

type Box = { x: number; y: number; width: number; height: number };

async function box(element: Locator): Promise<Box> {
	await element.scrollIntoViewIfNeeded();
	return (await element.boundingBox())!;
}

/** What a colour expression computes to, by asking the browser, so a token is exact. */
async function resolve(page: Page, expression: string): Promise<string> {
	return page.evaluate(value => {
		let probe = document.createElement("i");
		probe.style.color = value;
		document.body.append(probe);
		let result = getComputedStyle(probe).color;
		probe.remove();
		return result;
	}, expression);
}

test("the bar's dots take the 16px box and place of the icon the offline bar has", async ({ page }) => {
	// The offline bar's warning is the icon the reconnecting one has in its place: same box.
	let dropped = plate(page, "chat").locator('[data-connection-banner][data-phase="dropped"]')
		.first();
	let icon = await box(dropped.locator("svg.offline-bar-icon"));
	let strip = await box(dropped);
	for (let layer of ["socket"] as const) {
		let own = banner(page);
		let drawn = await box(dots(own));
		let around = await box(own);
		expect(drawn.width, layer).toBeCloseTo(16, 2);
		expect(drawn.height, layer).toBeCloseTo(16, 2);
		expect(drawn.x - around.x, `${layer} left`).toBeCloseTo(icon.x - strip.x, 2);
		expect(drawn.y - around.y, `${layer} top`).toBeCloseTo(icon.y - strip.y, 2);
		// Three round dots of 3.5px across the middle of the box, 1.5px apart.
		let circles = dots(own).locator(".connecting-dot");
		await expect(circles).toHaveCount(3);
		let lefts: number[] = [];
		for (let index of [0, 1, 2]) {
			let circle = await box(circles.nth(index));
			expect(circle.width, `${layer} dot ${index}`).toBeCloseTo(3.5, 1);
			expect(circle.height, `${layer} dot ${index}`).toBeCloseTo(3.5, 1);
			expect(circle.y + circle.height / 2, `${layer} dot ${index} middle`)
				.toBeCloseTo(drawn.y + drawn.height / 2, 1);
			expect(
				await circles.nth(index).evaluate(node =>
					Number.parseFloat(getComputedStyle(node).borderRadius)
				),
				`${layer} dot ${index} round`,
			).toBeGreaterThan(1000);
			lefts.push(circle.x);
		}
		expect(lefts[1]! - lefts[0]!, `${layer} spacing`).toBeCloseTo(5, 1);
		expect(lefts[2]! - lefts[1]!, `${layer} spacing`).toBeCloseTo(5, 1);
	}
});

test("the machine button's badge is a capsule as tall as the machine's dot, at its corner, holding the three dots", async ({ page }) => {
	let presence = plate(page, "chat").locator(".design-audit-planner-presence");
	let healthy = presence.locator('.machine-glyph-dot[data-state="connected"]').first();
	let healthyGlyph = await box(healthy.locator("xpath=.."));
	let dot = await box(healthy);
	let capsule = badge(page);
	let glyph = await box(capsule.locator("xpath=.."));
	let drawn = await box(capsule);
	// 14 by 8, with the 2px ring of the surface around it, as the machine's 8px dot has.
	expect(drawn.width).toBeCloseTo(18, 2);
	expect(drawn.height).toBeCloseTo(dot.height, 2);
	expect(drawn.y + drawn.height - (glyph.y + glyph.height))
		.toBeCloseTo(dot.y + dot.height - (healthyGlyph.y + healthyGlyph.height), 2);
	expect(drawn.x + drawn.width - (glyph.x + glyph.width))
		.toBeCloseTo(dot.x + dot.width - (healthyGlyph.x + healthyGlyph.width) + 2, 2);
	let border = await capsule.evaluate(node => getComputedStyle(node).borderTopWidth);
	expect(border).toBe("2px");
	expect(await capsule.evaluate(node => Number.parseFloat(getComputedStyle(node).borderRadius)))
		.toBeGreaterThan(1000);
	// The dots, of 3px, 1.5px apart, sit centred in its 14 by 8 inside the ring.
	let inside = await box(dots(capsule));
	expect(inside.width).toBeCloseTo(14, 2);
	expect(inside.height).toBeCloseTo(8, 2);
	let lefts: number[] = [];
	for (let index of [0, 1, 2]) {
		let circle = await box(dots(capsule).locator(".connecting-dot").nth(index));
		expect(circle.width, `dot ${index}`).toBeCloseTo(3, 1);
		expect(circle.height, `dot ${index}`).toBeCloseTo(3, 1);
		expect(circle.y + circle.height / 2, `dot ${index} middle`)
			.toBeCloseTo(drawn.y + drawn.height / 2, 1);
		lefts.push(circle.x);
	}
	expect(lefts[1]! - lefts[0]!).toBeCloseTo(4.5, 1);
	expect(lefts[2]! - lefts[1]!).toBeCloseTo(4.5, 1);
	expect(lefts[0]! - inside.x).toBeCloseTo(inside.x + inside.width - (lefts[2]! + 3), 1);
});

for (let mode of ["light", "dark"] as const) {
	test(`the dots are Chopin's petrol on the surface's own colour, in ${mode}`, async ({ page }) => {
		await page.evaluate(
			dark => document.documentElement.classList.toggle("dark", dark),
			mode === "dark",
		);
		let brand = await resolve(page, "var(--color-brand)");
		for (let [label, indicator] of indicators(page)) {
			let fills = await indicator.locator(".connecting-dot").evaluateAll(circles =>
				circles.map(circle => getComputedStyle(circle).backgroundColor)
			);
			expect(fills, label).toHaveLength(3);
			for (let fill of fills) expect(await resolve(page, fill), label).toBe(brand);
		}
		let ring = await badge(page).evaluate(node => getComputedStyle(node).backgroundColor);
		expect(await resolve(page, ring)).toBe(await resolve(page, "var(--color-page)"));
		expect(await badge(page).evaluate(node => getComputedStyle(node).borderTopColor))
			.toBe(ring);
	});
}

test("under reduced motion every indicator holds still, an ellipsis stepped from faint to full", async ({ page }) => {
	for (let [label, indicator] of indicators(page)) {
		await indicator.scrollIntoViewIfNeeded();
		expect(
			await indicator.locator(".connecting-dot").evaluateAll(circles =>
				circles.map(circle => ({
					moving: circle.getAnimations().length,
					opacity: getComputedStyle(circle).opacity,
				}))
			),
			label,
		).toEqual([
			{ moving: 0, opacity: "0.35" },
			{ moving: 0, opacity: "0.65" },
			{ moving: 0, opacity: "1" },
		]);
	}
});

test.describe("with motion allowed", () => {
	test.use({ contextOptions: { reducedMotion: "no-preference" } });

	test("each indicator's dots brighten in turn by opacity alone, and nothing around them moves", async ({ page }) => {
		for (let [label, indicator] of indicators(page)) {
			await indicator.scrollIntoViewIfNeeded();
			let waves = await indicator.locator(".connecting-dot").evaluateAll(circles =>
				circles.map(circle =>
					circle.getAnimations().map(animation => {
						let effect = animation.effect as KeyframeEffect;
						return {
							name: (animation as CSSAnimation).animationName,
							iterations: effect.getComputedTiming().iterations,
							duration: effect.getComputedTiming().duration,
							delay: effect.getTiming().delay,
							changes: [
								...new Set(
									effect.getKeyframes().flatMap(frame =>
										Object.keys(frame).filter(key =>
											!["offset", "computedOffset", "easing", "composite"].includes(key)
										)
									),
								),
							],
						};
					})
				)
			);
			expect(waves, label).toEqual([0, 200, 400].map(delay => [{
				name: "connecting-wave",
				iterations: Infinity,
				duration: 1200,
				delay,
				changes: ["opacity"],
			}]));
		}
		// Every frame of a whole wave lays the banners, their words and the badge out where the first did.
		let watched = [
			banner(page),
			banner(page).locator(".offline-bar-text"),
			dots(banner(page)),
			badge(page),
		];
		let handles = await Promise.all(watched.map(target => target.elementHandle()));
		let frames = await page.evaluate(async elements => {
			let seen = new Set<string>();
			let end = performance.now() + 1_400;
			while (performance.now() < end) {
				seen.add(JSON.stringify(elements.map(element => {
					let rect = element!.getBoundingClientRect();
					return [rect.x, rect.y, rect.width, rect.height];
				})));
				await new Promise(resolve => requestAnimationFrame(resolve));
			}
			return seen.size;
		}, handles);
		expect(frames).toBe(1);
	});
});
