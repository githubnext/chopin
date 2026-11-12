import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

import type { Locator, Page } from "@playwright/test";

/**
 * Chat's emoji and icons, on the design audit's own plates. Emoji are the platform's, drawn as text
 * in colour by the emoji fonts that follow Inter; Slack's emoji picker has Slack's proportions, its
 * keyboard and its remembered skin tone; and Chat's icons are one family, Chopin's 18-unit line
 * icons at one stroke, at Slack's sizes and centred in their buttons.
 */
const picker = (page: Page) => plate(page, "emoji").locator("[data-audit-picker]");

/** The plate draws its picker once asked, as Chat does. */
async function showPicker(page: Page): Promise<Locator> {
	let show = plate(page, "emoji").getByRole("button", { name: "Show the emoji picker" });
	await show.scrollIntoViewIfNeeded();
	await show.click();
	await expect(picker(page).locator("[data-emoji]").nth(100)).toBeAttached();
	return picker(page);
}

async function box(element: Locator) {
	await element.scrollIntoViewIfNeeded();
	return (await element.boundingBox())!;
}

/** How much of a glyph drawn in an element's own font is coloured rather than grey. */
async function colourful(element: Locator, text: string): Promise<number> {
	return element.evaluate((node, glyph) => {
		let canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 64;
		let context = canvas.getContext("2d")!;
		let style = getComputedStyle(node);
		context.font = `32px ${style.fontFamily}`;
		context.textBaseline = "top";
		context.fillStyle = "#000";
		context.fillText(glyph, 8, 8);
		let pixels = context.getImageData(0, 0, 64, 64).data;
		let coloured = 0;
		for (let index = 0; index < pixels.length; index += 4) {
			let [r, g, b, a] = [
				pixels[index]!,
				pixels[index + 1]!,
				pixels[index + 2]!,
				pixels[index + 3]!,
			];
			if (a > 128 && Math.max(r, g, b) - Math.min(r, g, b) > 40) coloured++;
		}
		return coloured;
	}, text);
}

test("every emoji is text in the platform's colour emoji font, and letters stay Inter's", async ({ page }) => {
	let emoji = plate(page, "emoji");
	await showPicker(page);
	// Text, never an image or a sprite.
	await expect(emoji.locator("img")).toHaveCount(0);
	await expect(plate(page, "assistant-ui").locator("[data-audit-reactions] img")).toHaveCount(0);
	let cell = picker(page).locator("[data-emoji]").first();
	// A text node (type 3), not an element.
	expect(await cell.evaluate(node => node.childNodes[0]?.nodeType)).toBe(3);
	let pill = plate(page, "assistant-ui").locator("[data-audit-reactions] .chat-reaction-emoji")
		.first();
	let inline = emoji.locator(".chat-markdown .chat-emoji").first();
	await expect(inline).toHaveText("\u2705");
	for (
		let [name, element] of [["picker cell", cell], ["pill", pill], ["in words", inline]] as const
	) {
		let family = await element.evaluate(node => getComputedStyle(node).fontFamily);
		expect(family, name).toMatch(
			/^"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Inter Variable"/,
		);
		// Drawn in colour: a black outline (DejaVu's) would have no coloured pixels at all.
		expect(await colourful(element, "\u{1F600}"), name).toBeGreaterThan(50);
	}
	// The words around an emoji are Inter's, with the emoji fonts after it, and © written plainly is text.
	let words = emoji.locator(".chat-markdown p").first();
	expect(await words.evaluate(node => getComputedStyle(node).fontFamily)).toMatch(
		/^"Inter Variable", "Apple Color Emoji"/,
	);
	await expect(words.locator(".chat-emoji")).toHaveText(["\u2705", "\u{1F680}"]);
});

test("an emoji in words is larger on the same line, and a message of only emoji is large", async ({ page }) => {
	let markdown = plate(page, "emoji").locator(".chat-markdown");
	let words = markdown.first().locator("p");
	let line = await words.evaluate(node => Number.parseFloat(getComputedStyle(node).lineHeight));
	let text = await words.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
	let inline = await words.locator(".chat-emoji").first().evaluate(node =>
		Number.parseFloat(getComputedStyle(node).fontSize)
	);
	expect(inline).toBeGreaterThan(text * 1.2);
	// The emoji never makes a line taller: the words are a whole number of lines.
	let lines = (await box(words)).height / line;
	expect(Math.abs(lines - Math.round(lines))).toBeLessThan(0.05);
	let jumbo = markdown.nth(1);
	await expect(jumbo).toHaveAttribute("data-chat-jumbo", "");
	let large = await jumbo.locator(".chat-emoji").first().evaluate(node =>
		Number.parseFloat(getComputedStyle(node).fontSize)
	);
	expect(large).toBeGreaterThanOrEqual(text * 1.5);
});

test("the picker has Slack's proportions: 360 by 420, nine tabs, nine columns, 22px emoji and a preview", async ({ page }) => {
	let panel = await showPicker(page);
	let viewport = page.viewportSize()!;
	let outer = await box(panel);
	expect(outer.width).toBeCloseTo(Math.min(360, viewport.width - 16), 0);
	expect(outer.height).toBeCloseTo(420, 0);
	let style = await panel.evaluate(node => {
		let computed = getComputedStyle(node);
		return { radius: computed.borderTopLeftRadius, shadow: computed.boxShadow };
	});
	expect(style.radius).toBe("8px");
	expect(style.shadow).not.toBe("none");

	let field = panel.getByRole("textbox", { name: "Search emoji, or paste one" });
	expect((await box(field)).height).toBeCloseTo(32, 0);
	await expect(field).toHaveAttribute("placeholder", "Search all emoji");

	let tabs = panel.getByRole("tab");
	await expect(tabs).toHaveCount(9);
	await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
	await expect(tabs.first()).toHaveAccessibleName("Frequently used");

	// Nine to a row, square, the emoji at Slack's 22px.
	let row = panel.locator(".emoji-picker-grid").nth(1).locator("[data-emoji]");
	let tops = await row.evaluateAll(nodes =>
		nodes.slice(0, 10).map(node => node.getBoundingClientRect().top)
	);
	expect(tops.slice(0, 9).every(top => top === tops[0])).toBe(true);
	expect(tops[9]).toBeGreaterThan(tops[0]!);
	let cell = await box(row.first());
	expect(cell.width).toBeCloseTo(cell.height, 0);
	expect(cell.width).toBeGreaterThanOrEqual(36);
	let size = await row.first().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
	expect(size).toBeGreaterThanOrEqual(21);
	expect(size).toBeLessThanOrEqual(24);

	// Frequently used first, a row of Slack's own picks, then Smileys and people.
	await expect(panel.locator(".emoji-picker-heading")).toHaveText([
		"Frequently used",
		"Smileys and people",
		"Animals and nature",
		"Food and drink",
		"Activities",
		"Travel and places",
		"Objects",
		"Symbols",
		"Flags",
	]);
	await expect(panel.locator(".emoji-picker-grid").first().locator("[data-emoji]")).toHaveCount(9);

	// The footer previews the emoji under the pointer, large, by its Slack name.
	await row.nth(1).hover();
	let preview = panel.locator(".emoji-picker-preview");
	await expect(preview.locator(".emoji-picker-preview-name")).toHaveText(/^:[\w+-]+:$/);
	let shown = await preview.locator(".emoji-picker-preview-emoji").evaluate(node =>
		Number.parseFloat(getComputedStyle(node).fontSize)
	);
	expect(shown).toBeGreaterThanOrEqual(26);
});

test("the picker's headings stay at the top as it scrolls, and the marked tab follows", async ({ page }) => {
	let panel = await showPicker(page);
	let list = panel.locator(".emoji-picker-list");
	await panel.getByRole("tab", { name: "Food and drink" }).click();
	await expect(panel.getByRole("tab", { name: "Food and drink" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect.poll(async () => {
		let heading = await box(panel.locator(".emoji-picker-heading", { hasText: "Food and drink" }));
		let top = await box(list);
		return Math.round(heading.y - top.y);
	}).toBe(0);
	// Scrolled by hand to Flags, the marker moves there.
	await list.evaluate(node => {
		let flags = node.querySelector<HTMLElement>('[data-emoji-section="flags"]')!;
		node.scrollTop = flags.offsetTop + 40;
	});
	await expect(panel.getByRole("tab", { name: "Flags" })).toHaveAttribute("aria-selected", "true");
	let heading = await box(panel.locator(".emoji-picker-heading", { hasText: "Flags" }));
	expect(Math.round(heading.y - (await box(list)).y)).toBe(0);
	await panel.getByRole("tab", { name: "Frequently used" }).click();
});

test("the keyboard reaches every emoji, the tabs and the skin tone, which is remembered", async ({ page }) => {
	let panel = await showPicker(page);
	let field = panel.getByRole("textbox", { name: "Search emoji, or paste one" });
	let cells = panel.locator("[data-emoji]");
	await field.focus();
	await page.keyboard.press("ArrowDown");
	await expect(cells.first()).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(cells.nth(1)).toBeFocused();
	// Down keeps the column into the next section; up from the top row goes back to the field.
	await page.keyboard.press("ArrowDown");
	await expect(cells.nth(9 + 1)).toBeFocused();
	await expect(panel.locator(".emoji-picker-preview-name")).toHaveText(/^:[\w+-]+:$/);
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowUp");
	await expect(field).toBeFocused();

	// Left and right move between the tabs.
	let tabs = panel.getByRole("tab");
	await tabs.first().focus();
	await page.keyboard.press("ArrowRight");
	await expect(tabs.nth(1)).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect(tabs.last()).toBeFocused();

	// The hand opens the six tones; one chosen tones the grid and is kept for the next picker.
	let hand = panel.getByRole("button", { name: "Skin tone: Default skin tone" });
	await hand.click();
	let tones = panel.getByRole("group", { name: "Skin tone" }).getByRole("button");
	await expect(tones).toHaveCount(6);
	await expect(tones.first()).toBeFocused();
	await panel.getByRole("button", { name: "Medium", exact: true }).click();
	await expect(panel.getByRole("button", { name: "Skin tone: Medium" })).toBeFocused();
	await expect(panel.getByRole("button", { name: "\u{1F44B}\u{1F3FD}" })).toBeAttached();
	expect(await page.evaluate(() => localStorage.getItem("chopin:emoji-tone"))).toBe("3");
	await panel.getByRole("button", { name: "Skin tone: Medium" }).click();
	await panel.getByRole("button", { name: "Default skin tone" }).click();
	await expect(panel.getByRole("button", { name: "\u{1F44B}", exact: true })).toBeAttached();
});

test("Chat's icons are one family: Chopin's 18-unit line icons, one stroke, centred, at Slack's sizes", async ({ page }) => {
	let groups: [string, Locator, number][] = [
		[
			"message toolbar",
			plate(page, "assistant-ui").locator(".chat-message-toolbar").last().locator("button svg"),
			20,
		],
		["composer", plate(page, "chat").locator(".chat-composer .btn-icon svg"), 18],
		["picker tabs", (await showPicker(page)).locator(".emoji-picker-tab svg"), 18],
	];
	for (let [name, icons, size] of groups) {
		await icons.first().scrollIntoViewIfNeeded();
		let count = await icons.count();
		expect(count, name).toBeGreaterThan(2);
		for (let index = 0; index < count; index++) {
			let icon = icons.nth(index);
			// A control the narrow composer gives way with is not drawn at all.
			if (!(await icon.isVisible())) continue;
			let drawn = await icon.evaluate(node => {
				let button = node.closest("button")!.getBoundingClientRect();
				let own = node.getBoundingClientRect();
				let group = node.querySelector("g");
				return {
					nucleo: node.hasAttribute("data-nucleo-icon") || node.hasAttribute("data-filled-icon"),
					viewBox: node.getAttribute("viewBox"),
					stroke: group?.getAttribute("stroke-width") ?? null,
					cap: group?.getAttribute("stroke-linecap") ?? null,
					width: own.width,
					height: own.height,
					dx: own.left + own.width / 2 - (button.left + button.width / 2),
					dy: own.top + own.height / 2 - (button.top + button.height / 2),
				};
			});
			let where = `${name} icon ${index}`;
			expect(drawn.nucleo, where).toBe(true);
			if (drawn.stroke !== null) {
				expect(drawn.viewBox, where).toBe("0 0 18 18");
				expect(drawn.stroke, where).toBe("1.5");
				expect(drawn.cap, where).toBe("round");
			}
			expect(drawn.width, where).toBeCloseTo(size, 0);
			expect(drawn.height, where).toBeCloseTo(size, 0);
			expect(Math.abs(drawn.dx), `${where} centred across`).toBeLessThanOrEqual(0.5);
			expect(Math.abs(drawn.dy), `${where} centred down`).toBeLessThanOrEqual(0.5);
		}
	}
	// No lucide artwork anywhere on the audit page: every copy's icons are Chopin's.
	await expect(page.locator("svg.lucide")).toHaveCount(0);
});
