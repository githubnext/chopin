import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

import type { Locator, Page } from "@playwright/test";

/**
 * Chat's images, placeholders and files take Slack's proportions and Chopin's colours. Each size
 * below is Slack's, with its source:
 * - Slack's web client CSS: an image's `.p-file_image_thumbnail__wrapper` has a 1px edge and 8px
 *   corners; its `.c-file__actions--image` toolbar sits 10px from the image's top and end; a
 *   gallery's images are 4px apart; `.c-message_kit__file__meta`, the name above an image, is
 *   4px above it.
 * - Slack's thumbnail sizes (`thumb_480` wide, `thumb_360` tall) bound an image in a message.
 * - Slack's file card and composer, as drawn by its web client: a 12px-cornered card with a 1px
 *   edge, 12px padding and a 40px type icon; a staged image is a 64px square.
 * Every colour is one of Chopin's tokens, in light and in dark.
 */

function media(page: Page): Locator {
	return plate(page, "chat-media");
}

async function box(locator: Locator) {
	await locator.scrollIntoViewIfNeeded();
	return (await locator.boundingBox())!;
}

async function css(locator: Locator, ...properties: string[]): Promise<string[]> {
	return locator.evaluate(
		(element, names) => names.map(name => getComputedStyle(element).getPropertyValue(name)),
		properties,
	);
}

/** A token's colour, as the browser serializes it. */
async function token(page: Page, name: string, property = "color"): Promise<string> {
	return page.evaluate(([variable, property]) => {
		let probe = document.createElement("span");
		probe.style.setProperty(property!, `var(${variable})`);
		document.body.append(probe);
		let value = getComputedStyle(probe).getPropertyValue(property!);
		probe.remove();
		return value;
	}, [name, property]);
}

test("an image is Slack's frame, at most 480 wide, with its toolbar 10px into its corner", async ({ page }) => {
	let figure = media(page).locator('[data-chat-image="single"]').first();
	await expect(figure).toHaveAttribute("data-load", "shown");
	let frame = figure.locator(".chat-image-frame");
	expect(await css(frame, "border-top-width", "border-top-left-radius")).toEqual(["1px", "8px"]);
	let framed = await box(frame);
	expect(framed.width).toBeLessThanOrEqual(482);
	let meta = await box(figure.locator(".chat-image-meta"));
	expect(Math.round(framed.y - (meta.y + meta.height))).toBe(4);

	await frame.hover();
	let toolbar = figure.locator('.chat-image-actions-slot [data-slot="image-actions"]');
	await expect(figure.locator(".chat-image-actions-slot")).toHaveCSS("opacity", "1");
	let bar = await box(toolbar);
	expect(Math.round(framed.x + framed.width - (bar.x + bar.width))).toBe(10);
	expect(Math.round(bar.y - framed.y)).toBe(10);
	expect(await css(toolbar, "padding-top", "border-top-left-radius")).toEqual(["2px", "8px"]);
	for (let button of await toolbar.getByRole("button").all()) {
		let size = await box(button);
		expect([size.width, size.height]).toEqual([32, 32]);
		expect(await css(button, "border-top-left-radius")).toEqual(["4px"]);
	}
});

test("several images are Slack's grid: 4px apart, 8px corners, at most 480 wide", async ({ page }) => {
	let galleries = media(page).locator("[data-chat-image-gallery]");
	await expect(galleries).toHaveCount(3);
	for (let [index, shape] of ["pair", "trio", "quad"].entries()) {
		let gallery = galleries.nth(index);
		await expect(gallery).toHaveAttribute("data-shape", shape);
		expect((await box(gallery)).width).toBeLessThanOrEqual(480);
		let tiles = gallery.locator('[data-chat-image="tile"]');
		let first = await box(tiles.nth(0));
		let second = await box(tiles.nth(1));
		expect(Math.round(second.x - (first.x + first.width))).toBe(4);
		expect(await css(tiles.nth(0), "border-top-left-radius")).toEqual(["8px"]);
	}
	let quad = galleries.nth(2).locator('[data-chat-image="tile"]');
	await expect(quad).toHaveCount(4);
	await expect(quad.nth(3)).toContainText("+2");
	let trio = galleries.nth(1).locator('[data-chat-image="tile"]');
	expect((await box(trio.nth(0))).height).toBeCloseTo((await box(trio.nth(1))).height * 2 + 4, 0);
});

test("an image that cannot be shown is Slack's quiet box of 360 by 240, saying why", async ({ page }) => {
	let figure = media(page).locator('[data-chat-image="single"]').nth(1);
	let placeholder = figure.getByRole("img", { name: "Image can’t be shown: floor-plan.png" });
	await expect(placeholder).toBeVisible();
	let framed = await box(figure.locator(".chat-image-frame"));
	expect(framed.height).toBe(242);
	expect(framed.width).toBeLessThanOrEqual(362);
	expect(await css(placeholder.locator("svg"), "width")).toEqual(["24px"]);
});

test("a file is Slack's card: 12px corners, a 1px edge, 12px padding, a 40px icon, 8px apart", async ({ page }) => {
	let cards = media(page).locator('[data-chat-files] [data-slot="message-attachment"]');
	await expect(cards).toHaveCount(8);
	let kinds = await cards.locator(".chat-file-icon").evaluateAll(icons =>
		icons.map(icon => icon.getAttribute("data-file-kind"))
	);
	expect(kinds).toEqual([
		"pdf",
		"text",
		"spreadsheet",
		"slides",
		"code",
		"archive",
		"document",
		"generic",
	]);
	let card = cards.nth(0).locator("button").first();
	expect(await css(card, "border-top-width", "border-top-left-radius", "padding-top", "min-height"))
		.toEqual(["1px", "12px", "12px", "64px"]);
	let icon = await box(cards.nth(0).locator(".chat-file-icon"));
	expect([icon.width, icon.height]).toEqual([40, 40]);
	let gap = (await box(cards.nth(1))).y
		- ((await box(cards.nth(0))).y + (await box(cards.nth(0))).height);
	expect(Math.round(gap)).toBe(8);
	await card.hover();
	let toolbar = cards.nth(0).locator(".chat-file-actions");
	await expect(toolbar).toHaveCSS("opacity", "1");
	for (let button of await toolbar.getByRole("button").all()) {
		let size = await box(button);
		expect([size.width, size.height]).toEqual([32, 32]);
	}
});

test("a staged image is a 64px square and a staged file a short card, each with its remove on the corner", async ({ page }) => {
	let chips = media(page).locator('[data-slot="composer-attachment"]');
	await expect(chips).toHaveCount(3);
	let image = await box(chips.nth(0));
	expect([image.width, image.height]).toEqual([64, 64]);
	expect(await css(chips.nth(0), "border-top-left-radius")).toEqual(["12px"]);
	await expect(chips.nth(0).locator(".composer-file-ring")).toBeVisible();
	let file = await box(chips.nth(1));
	// The same height as an image's square, so a row of them lines up as Slack's does.
	expect(file.height).toBe(64);
	let icon = await box(chips.nth(1).locator(".chat-file-icon"));
	expect([icon.width, icon.height]).toEqual([40, 40]);
	await chips.nth(1).hover();
	let remove = chips.nth(1).getByRole("button", { name: "Remove rollout-notes.md" });
	await expect(remove).toHaveCSS("opacity", "1");
	let corner = await box(remove);
	expect([corner.width, corner.height]).toEqual([20, 20]);
	expect(Math.round(file.x + file.width - (corner.x + corner.width))).toBe(4);
});

for (let mode of ["light", "dark"] as const) {
	test(`every colour of Chat's media is one of Chopin's tokens, in ${mode}`, async ({ page }) => {
		if (mode === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
		let figure = media(page).locator('[data-chat-image="single"]').first();
		await expect(figure).toHaveAttribute("data-load", "shown");
		let frame = figure.locator(".chat-image-frame");
		expect(await css(frame, "border-top-color")).toEqual([
			await token(page, "--color-button-outline-edge"),
		]);
		await frame.hover();
		let toolbar = figure.locator('.chat-image-actions-slot [data-slot="image-actions"]');
		expect(await css(toolbar, "background-color")).toEqual([
			await token(page, "--color-page", "background-color"),
		]);
		expect(await css(toolbar, "outline-color")).toEqual([await token(page, "--color-edge")]);

		let icons = media(page).locator(".chat-file-icon");
		let expected = {
			pdf: "--color-danger-graphic",
			document: "--color-brand",
			spreadsheet: "--color-success",
			slides: "--color-warning",
			code: "--color-text-secondary",
			text: "--color-icon",
			archive: "--color-warning-ink",
			generic: "--color-text-tertiary",
		};
		for (let icon of await icons.all()) {
			let kind = (await icon.getAttribute("data-file-kind")) as keyof typeof expected;
			expect(await css(icon, "background-color"), kind).toEqual([
				await token(page, expected[kind], "background-color"),
			]);
			expect(await css(icon, "color"), kind).toEqual([await token(page, "--color-page")]);
		}
		let card = media(page).locator('[data-chat-files] [data-slot="message-attachment"] > button')
			.first();
		expect(await css(card, "background-color", "border-top-color")).toEqual([
			await token(page, "--color-page", "background-color"),
			await token(page, "--color-button-outline-edge"),
		]);
		let placeholder = media(page).locator("[data-chat-image-broken] ").first();
		expect(await css(placeholder, "background-color")).toEqual([
			await token(page, "--color-inset", "background-color"),
		]);

		// The viewer is Slack's dark ground in Chopin's ink, with the page's colour for its words.
		await frame.click();
		let viewer = page.locator('[data-slot="dialog-content"]');
		await expect(viewer.locator("[data-chat-viewer-header]")).toBeVisible();
		expect(await css(viewer, "background-color", "color")).toEqual([
			await token(page, "--color-text-primary", "background-color"),
			await token(page, "--color-page"),
		]);
		expect(await css(viewer.locator(".chat-viewer-name"), "color")).toEqual([
			await token(page, "--color-page"),
		]);
		await page.keyboard.press("Escape");
		await expect(viewer).toHaveCount(0);
	});
}
