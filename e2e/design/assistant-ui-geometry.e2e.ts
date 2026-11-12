import { expect } from "@playwright/test";
import { plate, test } from "./fixture";
import { expected } from "./tailwind-geometry";

import type { Sides } from "./tailwind-geometry";

import type { Locator, Page } from "@playwright/test";

/**
 * Every copied assistant-ui element on the audit plate is measured against its own Tailwind classes
 * (`tailwind-geometry.ts`), under a fine pointer and under a forced coarse one. To add an element:
 * put it on the plate, add its roots to `ROOTS` and what a finger aims at to `TARGETS`.
 */
type Measured = {
	width: number;
	height: number;
	padding: Sides;
	border: Sides;
	radius: number;
	radii: Sides;
	gap: number;
	fontSize: number;
	lineHeight: number;
};

/** The visible box of an element, in numbers. */
async function measure(element: Locator): Promise<Measured> {
	return element.evaluate(node => {
		let style = getComputedStyle(node);
		let box = node.getBoundingClientRect();
		let px = (value: string) => Number.parseFloat(value) || 0;
		return {
			width: box.width,
			height: box.height,
			padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
				px,
			),
			border: [
				style.borderTopWidth,
				style.borderRightWidth,
				style.borderBottomWidth,
				style.borderLeftWidth,
			].map(px),
			radius: px(style.borderTopLeftRadius),
			radii: [
				style.borderTopLeftRadius,
				style.borderTopRightRadius,
				style.borderBottomRightRadius,
				style.borderBottomLeftRadius,
			].map(px),
			gap: px(style.columnGap),
			fontSize: px(style.fontSize),
			lineHeight: px(style.lineHeight),
		} as Measured;
	});
}

/** Every measured property that the element's own classes decide equals the class's pixels. */
async function expectClassGeometry(element: Locator, label: string) {
	let [className, tagName] = await element.evaluate(node => [
		node.getAttribute("class") ?? "",
		node.tagName.toLowerCase(),
	]);
	let want = expected(className, tagName);
	let got = await measure(element);
	let at = `${label} (${className})`;
	if (want.height !== undefined) expect(got.height, `${at} height`).toBeCloseTo(want.height, 1);
	if (want.width !== undefined) expect(got.width, `${at} width`).toBeCloseTo(want.width, 1);
	for (let [index, side] of Object.entries(want.padding ?? {})) {
		expect(got.padding[Number(index) as 0 | 1 | 2 | 3], `${at} padding side ${index}`)
			.toBeCloseTo(side, 2);
	}
	expect(got.border, `${at} border widths`).toEqual(want.border);
	if (want.radii) {
		for (let corner of [0, 1, 2, 3] as const) {
			if (want.radii[corner] === Infinity) {
				expect(got.radii[corner], `${at} corner ${corner}`).toBeGreaterThan(1000);
			} else expect(got.radii[corner], `${at} corner ${corner}`).toBeCloseTo(want.radii[corner], 2);
		}
	} else if (want.radius === Infinity) expect(got.radius, `${at} radius`).toBeGreaterThan(1000);
	else expect(got.radius, `${at} radius`).toBeCloseTo(want.radius, 2);
	if (want.gap !== undefined) expect(got.gap, `${at} gap`).toBeCloseTo(want.gap, 2);
	if (want.fontSize !== undefined) {
		expect(got.fontSize, `${at} font size`).toBeCloseTo(want.fontSize, 2);
	}
	if (want.lineHeight !== undefined) {
		expect(got.lineHeight, `${at} line height`).toBeCloseTo(want.lineHeight, 2);
	}
}

/** Each root a copied element draws, and what a person can aim at in it. */
const ROOTS = {
	closed: [
		"model-selector-trigger",
		"composer-menu",
		"composer-menu-item",
		"composer-attachments",
		"composer-attachment",
		"composer-voice",
		"composer-voice-button",
		"message-attachments",
		"markdown-text",
		"composer-context",
		"context-breakdown",
		"image-root",
		"image-preview",
		"image-preview-error",
		"image-generating",
		"image-content-filter-error",
		"image-filename",
		"image-source",
		"image-source-icon-fallback",
		"image-source-label",
		"image-actions",
		"image-download",
		"image-copy",
		"image-regenerate",
		"image-gallery",
		"message-actions",
		"agent-handoff",
		"subagent-list",
	],
	open: [
		"model-selector-content",
		"command",
		"command-input-wrapper",
		"input-group",
		"model-selector-search",
		"model-selector-list",
		"command-group",
		"model-selector-item",
		"model-selector-effort",
	],
	menu: [
		"dropdown-menu-content",
		"dropdown-menu-item",
		"dropdown-menu-separator",
	],
} as const;
/** What a staged chip's picture box, a sent file's tiles and a gallery's grid/tiles are. */
const BOXES = [
	'[data-slot="composer-attachment"] > span:first-child',
	'[data-slot="message-attachments"] > *',
	'[data-slot="image-gallery"] > div',
	'[data-slot="image-gallery"] button',
] as const;
const MARKDOWN_PARTS: readonly [label: string, select: (root: Locator) => Locator][] = [
	["h1", root => root.locator(".aui-md-h1")],
	["h2", root => root.locator(".aui-md-h2").first()],
	["h3", root => root.locator(".aui-md-h3")],
	["h4", root => root.locator(".aui-md-h4")],
	["h5", root => root.locator(".aui-md-h5")],
	["h6", root => root.locator(".aui-md-h6")],
	["p", root => root.locator(".aui-md-p").first()],
	["a", root => root.locator(".aui-md-a").first()],
	["blockquote", root => root.locator(".aui-md-blockquote")],
	["ul", root => root.locator(".aui-md-ul").first()],
	["ol", root => root.locator(".aui-md-ol").first()],
	["li", root => root.locator(".aui-md-li").first()],
	["hr", root => root.locator(".aui-md-hr")],
	["table-wrapper", root => root.locator(".aui-md-table-wrapper")],
	["table", root => root.locator(".aui-md-table")],
	["th", root => root.locator(".aui-md-th").nth(1)],
	["td", root => root.locator(".aui-md-td").first()],
	["tr", root => root.locator("tbody .aui-md-tr").nth(1)],
	["strong", root => root.locator(".aui-md-strong")],
	["sup", root => root.locator(".aui-md-sup")],
	["inline-code", root => root.locator(".aui-md-inline-code")],
	["code-header", root => root.locator(".aui-code-header-root")],
	["code-language", root => root.locator(".aui-code-header-language")],
	["copy-button", root => root.locator(".aui-button-icon")],
	["pre", root => root.locator(".aui-md-pre")],
];
const TARGETS =
	'[data-slot="model-selector-trigger"], [data-slot="model-selector-item"], [data-slot="composer-menu-item"], [role="radio"], [data-slot="composer-voice-button"], [data-slot="composer-attachment"] button:not([data-chopin-control]), [data-slot="message-attachments"] button, [data-slot="markdown-text"] .aui-button-icon, [data-slot="markdown-text"] .aui-md-a, [data-slot="composer-context"] > button, [data-slot="message-actions"] button, [data-slot="dropdown-menu-item"], [data-chat-reaction], [data-slot="image-download"], [data-slot="image-copy"], [data-slot="image-regenerate"], [data-slot="image-source-label"], [data-slot="image-gallery"] button';
const slot = (page: Page, name: string) => page.locator(`[data-slot="${name}"]`);
const effortRadios = (page: Page) => slot(page, "model-selector-effort").getByRole("radio");

async function openSelector(page: Page): Promise<Locator> {
	let trigger = plate(page, "assistant-ui").getByRole("combobox").first();
	await trigger.scrollIntoViewIfNeeded();
	await trigger.click();
	await expect(slot(page, "model-selector-content")).toBeVisible();
	await expect(slot(page, "model-selector-effort")).toBeVisible();
	// The popup enters with a zoom and a fade; measure it settled.
	await expect.poll(() =>
		slot(page, "model-selector-content").evaluate(node => getComputedStyle(node).opacity)
	).toBe("1");
	return trigger;
}

async function openGalleryDialog(page: Page): Promise<Locator> {
	let tile = plate(page, "assistant-ui").locator('[data-slot="image-gallery"] button').first();
	await tile.scrollIntoViewIfNeeded();
	await tile.click();
	let dialog = slot(page, "dialog-content");
	await expect(dialog).toBeVisible();
	await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
	return dialog;
}

function restChrome(locator: Locator) {
	return locator.evaluate(node => {
		let style = getComputedStyle(node);
		return {
			border: [
				style.borderTopWidth,
				style.borderRightWidth,
				style.borderBottomWidth,
				style.borderLeftWidth,
			].map(value => Number.parseFloat(value) || 0),
			borderColor: style.borderTopColor,
			shadow: style.boxShadow,
			outline: style.outlineStyle,
		};
	});
}

async function openMenu(page: Page): Promise<Locator> {
	let trigger = plate(page, "assistant-ui").getByRole("button", { name: "More actions" });
	await trigger.scrollIntoViewIfNeeded();
	await trigger.click();
	await expect(slot(page, "dropdown-menu-content")).toBeVisible();
	await expect.poll(() =>
		slot(page, "dropdown-menu-content").evaluate(node => getComputedStyle(node).opacity)
	).toBe("1");
	return trigger;
}

test("a copied element is as many pixels as its Tailwind classes say, not as Chopin's scale would make it", async ({ page }) => {
	let checked = 0;
	await expect(plate(page, "assistant-ui").locator('[data-slot="image-preview-error"]'))
		.toBeVisible();
	for (let name of ROOTS.closed) {
		// Chopin's message toolbar is the copied row restyled as Slack's box, measured below.
		let elements = plate(page, "assistant-ui").locator(
			`[data-slot="${name}"]:not(.chat-message-toolbar)`,
		);
		expect(await elements.count(), `${name} is drawn`).toBeGreaterThan(0);
		for (let index = 0; index < await elements.count(); index++) {
			await expectClassGeometry(elements.nth(index), name);
			checked++;
		}
	}
	for (let selector of BOXES) {
		let boxes = plate(page, "assistant-ui").locator(selector);
		expect(await boxes.count(), `${selector} is drawn`).toBeGreaterThan(0);
		for (let index = 0; index < await boxes.count(); index++) {
			await expectClassGeometry(boxes.nth(index), selector);
			checked++;
		}
	}
	let markdown = plate(page, "assistant-ui").locator('[data-slot="markdown-text"]');
	for (let [label, select] of MARKDOWN_PARTS) {
		let part = select(markdown);
		await expect(part, `markdown ${label} is drawn`).toBeVisible();
		await expectClassGeometry(part, `markdown ${label}`);
		checked++;
	}
	let copy = markdown.locator(".aui-button-icon");
	await copy.scrollIntoViewIfNeeded();
	await copy.hover();
	await expect(slot(page, "tooltip-content")).toBeVisible();
	await expect.poll(() =>
		slot(page, "tooltip-content").evaluate(node => getComputedStyle(node).opacity)
	).toBe("1");
	await expectClassGeometry(slot(page, "tooltip-content"), "tooltip-content");
	checked++;

	await openSelector(page);
	for (let name of ROOTS.open) {
		let elements = slot(page, name);
		expect(await elements.count(), `${name} is drawn`).toBeGreaterThan(0);
		for (let index = 0; index < await elements.count(); index++) {
			await expectClassGeometry(elements.nth(index), name);
			checked++;
		}
	}
	let radios = slot(page, "model-selector-effort").getByRole("radio");
	expect(await radios.count()).toBe(3);
	for (let index = 0; index < 3; index++) {
		await expectClassGeometry(radios.nth(index), "effort radio");
		checked++;
	}
	let ringButtons = plate(page, "assistant-ui").locator('[data-slot="composer-context"] > button');
	expect(await ringButtons.count()).toBe(2);
	for (let index = 0; index < 2; index++) {
		await expectClassGeometry(ringButtons.nth(index), "composer-context button");
		checked++;
	}
	await page.keyboard.press("Escape");
	let firstRing = ringButtons.first();
	await firstRing.scrollIntoViewIfNeeded();
	await firstRing.focus();
	let floatingPanel = plate(page, "assistant-ui")
		.locator('[data-slot="composer-context"] > div')
		.first();
	await expect.poll(() => floatingPanel.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
	await expectClassGeometry(floatingPanel, "composer-context floating");
	checked++;
	await page.keyboard.press("Escape");

	let dialog = await openGalleryDialog(page);
	await expectClassGeometry(dialog, "dialog-content");
	await expectClassGeometry(dialog.getByRole("button", { name: "Previous image" }), "previous");
	await expectClassGeometry(dialog.getByRole("button", { name: "Next image" }), "next");
	checked += 3;
	await page.keyboard.press("Escape");
	await openMenu(page);
	for (let name of ROOTS.menu) {
		let elements = slot(page, name);
		expect(await elements.count(), `${name} is drawn`).toBeGreaterThan(0);
		for (let index = 0; index < await elements.count(); index++) {
			await expectClassGeometry(elements.nth(index), name);
			checked++;
		}
	}
	expect(checked).toBe(133);
});

test("handoff and subagent list keep assistant-ui's exact proportions", async ({ page }) => {
	let handoff = plate(page, "assistant-ui").locator('[data-slot="agent-handoff"]').first();
	await handoff.scrollIntoViewIfNeeded();
	let pills = handoff.locator("> div").first().locator("> span");
	expect(await pills.count()).toBe(2);
	for (let index = 0; index < 2; index++) {
		await expectClassGeometry(pills.nth(index), `handoff pill ${index}`);
		let pill = await measure(pills.nth(index));
		expect([pill.padding, pill.fontSize, pill.lineHeight]).toEqual([[4, 10, 4, 10], 12, 16]);
		expect(pill.radius).toBeGreaterThan(1000);
	}
	let carried = await measure(handoff.locator("> div").nth(1).locator("> span").nth(1));
	expect([carried.border, carried.padding[3], carried.fontSize]).toEqual([[0, 0, 0, 1], 10, 12]);

	// Tailwind's `rounded-2xl` is 16px, which Chopin's theme drops altogether.
	let subagents = plate(page, "assistant-ui").locator('[data-slot="subagent-list"]').nth(1);
	await subagents.scrollIntoViewIfNeeded();
	let cards = subagents.locator("> div");
	expect(await cards.count()).toBe(3);
	for (let index = 0; index < 3; index++) {
		await expectClassGeometry(cards.nth(index), `subagent card ${index}`);
		let card = await measure(cards.nth(index));
		expect([card.radius, card.border, card.padding]).toEqual([
			16,
			[1, 1, 1, 1],
			[10, 14, 10, 14],
		]);
		let bar = await measure(cards.nth(index).getByRole("progressbar"));
		expect(bar.height).toBeCloseTo(3, 1);
		expect(bar.radius).toBeGreaterThan(1000);
	}
});

test("message-actions and dropdown-menu keep their registry geometry; Chopin's toolbar and reaction pills take Slack's", async ({ page }) => {
	let rows = plate(page, "assistant-ui").locator('[data-slot="message-actions"]');
	expect(await rows.count()).toBe(5);
	let row = rows.first();
	await row.scrollIntoViewIfNeeded();
	let bar = await measure(row);
	expect([bar.height, bar.padding, bar.border, bar.radius, bar.gap]).toEqual([
		28,
		[0, 0, 0, 0],
		[0, 0, 0, 0],
		0,
		4,
	]);
	let chrome = await row.evaluate(node => {
		let style = getComputedStyle(node);
		return { outline: style.outlineStyle, shadow: style.boxShadow };
	});
	expect(chrome).toEqual({ outline: "none", shadow: "none" });

	let buttons = row.getByRole("button");
	expect(await buttons.count()).toBe(5);
	for (let index = 0; index < 5; index++) {
		let button = buttons.nth(index);
		await expectClassGeometry(button, "message-actions button");
		let box = await measure(button);
		expect([box.width, box.height, box.padding, box.border]).toEqual([
			28,
			28,
			[0, 0, 0, 0],
			[0, 0, 0, 0],
		]);
		expect(box.radius).toBeGreaterThan(1000);
		let icon = await measure(button.locator("svg").first());
		expect([icon.width, icon.height]).toEqual([14, 14]);
	}

	// Slack's `c-message_actions__group`: 2px inside a rounded square with a hairline ring and a soft
	// shadow, its `c-message_actions__button`s 32px squares with 4px corners and no gap between them.
	let toolbar = plate(page, "assistant-ui").locator(".chat-message-toolbar");
	await toolbar.scrollIntoViewIfNeeded();
	let box = await measure(toolbar);
	expect([box.height, box.padding, box.border, box.radius, box.gap]).toEqual([
		36,
		[2, 2, 2, 2],
		[0, 0, 0, 0],
		8,
		0,
	]);
	let ring = await toolbar.evaluate(node => {
		let style = getComputedStyle(node);
		return { outline: style.outlineStyle, shadow: style.boxShadow !== "none" };
	});
	expect(ring).toEqual({ outline: "solid", shadow: true });
	let tools = toolbar.getByRole("button");
	expect(await tools.evaluateAll(all => all.map(node => node.getAttribute("aria-label")))).toEqual([
		"Looks right",
		"Explain this",
		"Not quite",
		"Add reaction",
		"Reply in thread",
		"Message actions",
	]);
	for (let index = 0; index < 6; index++) {
		let tool = await measure(tools.nth(index));
		expect([tool.width, tool.height, tool.radius], `toolbar button ${index}`).toEqual([32, 32, 4]);
	}
	for (let index = 3; index < 6; index++) {
		let icon = await measure(tools.nth(index).locator("svg").first());
		expect([icon.width, icon.height], `toolbar icon ${index}`).toEqual([20, 20]);
	}

	// Slack's `c-reaction`: a 24px pill, 6px each side, an emoji and its count 2px apart, with a ring.
	let pills = plate(page, "assistant-ui").locator("[data-chat-reaction]");
	expect(await pills.count()).toBe(2);
	for (let index = 0; index < 2; index++) {
		let pill = pills.nth(index);
		let box = await measure(pill);
		expect([box.height, box.padding[1], box.padding[3], box.border, box.gap]).toEqual([
			24,
			6,
			6,
			[0, 0, 0, 0],
			2,
		]);
		expect(box.radius).toBeGreaterThan(1000);
		expect(await pill.evaluate(node => getComputedStyle(node).outlineStyle)).toBe("solid");
	}

	await openMenu(page);
	let popup = await measure(slot(page, "dropdown-menu-content"));
	expect([popup.radius, popup.padding, popup.border]).toEqual([
		8,
		[4, 4, 4, 4],
		[0, 0, 0, 0],
	]);
	let item = await measure(slot(page, "dropdown-menu-item").first());
	expect([
		item.height,
		item.padding,
		item.radius,
		item.gap,
		item.fontSize,
		item.lineHeight,
	]).toEqual([28, [4, 6, 4, 6], 6, 6, 14, 20]);
	expect((await measure(slot(page, "dropdown-menu-separator"))).height).toBe(1);
});

test("assistant-ui's own radii, in pixels, where Chopin's scale differs", async ({ page }) => {
	// Tailwind's `rounded-xl` is 12px and Chopin's is 10px, and `rounded-2xl` (16px, the context
	// breakdown) is absent from Chopin's scale: the popup, its list, the code block header and body,
	// the gallery tiles and the lightbox are the proof. The hand-adapted code header was 28px tall
	// (9px shorter), with a 6px radius and 2px by 12px/4px padding; assistant-ui's is 37px tall
	// (`py-1.5` + `size-6` + 1px top border), with 12px top corners and 6px by 14px padding.
	let markdown = plate(page, "assistant-ui").locator('[data-slot="markdown-text"]');
	let codeHeader = await measure(markdown.locator(".aui-code-header-root"));
	expect(codeHeader.height).toBeCloseTo(37, 1);
	expect(codeHeader.padding).toEqual([6, 14, 6, 14]);
	expect(codeHeader.border).toEqual([1, 1, 0, 1]);
	expect(codeHeader.radii).toEqual([12, 12, 0, 0]);
	expect([codeHeader.fontSize, codeHeader.lineHeight]).toEqual([12, 16]);

	let copyButton = await measure(markdown.locator(".aui-button-icon"));
	expect([copyButton.width, copyButton.height]).toEqual([24, 24]);
	expect(copyButton.padding).toEqual([4, 4, 4, 4]);
	expect(copyButton.radius).toBe(8);

	let pre = await measure(markdown.locator(".aui-md-pre"));
	expect(pre.padding).toEqual([14, 14, 14, 14]);
	expect(pre.border).toEqual([0, 1, 1, 1]);
	expect(pre.radii).toEqual([0, 0, 12, 12]);
	expect(pre.fontSize).toBe(13);

	expect((await measure(markdown.locator(".aui-md-th").first())).radii).toEqual([8, 0, 0, 0]);
	expect((await measure(markdown.locator(".aui-md-th").last())).radii).toEqual([0, 8, 0, 0]);
	expect(
		(await measure(markdown.locator("tbody .aui-md-tr").last().locator(".aui-md-td").first()))
			.radii,
	).toEqual([0, 0, 0, 8]);
	let bottomRightCell = await measure(
		markdown.locator("tbody .aui-md-tr").last().locator(".aui-md-td").last(),
	);
	expect(bottomRightCell.radii).toEqual([0, 0, 8, 0]);
	expect(bottomRightCell.border).toEqual([0, 1, 1, 1]);

	await openSelector(page);
	expect((await measure(slot(page, "model-selector-content"))).radius).toBe(12);
	expect((await measure(slot(page, "command").first())).radius).toBe(12);
	expect((await measure(slot(page, "model-selector-item").first())).radius).toBe(8);
	expect((await measure(effortRadios(page).first())).radius).toBe(6);
	expect((await measure(slot(page, "context-breakdown").first())).radius).toBe(16);
	let ringButton = await measure(
		plate(page, "assistant-ui").locator('[data-slot="composer-context"] > button').first(),
	);
	expect([ringButton.width, ringButton.height]).toEqual([32, 32]);
	expect(ringButton.radius).toBeGreaterThan(1000);
	await page.keyboard.press("Escape");

	let tile = plate(page, "assistant-ui").locator('[data-slot="image-gallery"] button').first();
	expect((await measure(tile)).radius).toBe(12);
	expect(
		(await measure(plate(page, "assistant-ui").locator('[data-slot="image-root"]').first()))
			.radius,
	).toBe(8);
	// And its type: `text-sm` is 14px on 20px, not Chopin's fluid step on 1.5; `text-xs` is 12px on 16px.
	let trigger = await measure(plate(page, "assistant-ui").getByRole("combobox").first());
	expect([trigger.fontSize, trigger.lineHeight]).toEqual([14, 20]);
	expect([trigger.height, trigger.padding[1], trigger.padding[3]]).toEqual([36, 12, 12]);
	let filename = await measure(
		plate(page, "assistant-ui").locator('[data-slot="image-filename"]')
			.first(),
	);
	expect([filename.fontSize, filename.lineHeight]).toEqual([12, 16]);
});

test("tile buttons, single-image actions and lightbox prev/next carry no resting rings, borders or shadows", async ({ page }) => {
	let tiles = plate(page, "assistant-ui").locator('[data-slot="image-gallery"] button');
	expect(await tiles.count()).toBe(6);
	for (let index = 0; index < 6; index++) {
		expect(await restChrome(tiles.nth(index)), `tile ${index}`).toMatchObject({
			border: [0, 0, 0, 0],
			shadow: "none",
			outline: "none",
		});
	}

	for (let name of ["image-download", "image-copy", "image-regenerate"]) {
		let action = plate(page, "assistant-ui").locator(`[data-slot="${name}"]`);
		let sized = await measure(action);
		expect([sized.width, sized.height, sized.radius], name).toEqual([28, 28, 4]);
		expect(await restChrome(action), name).toMatchObject({
			border: [0, 0, 0, 0],
			shadow: "none",
			outline: "none",
		});
	}

	let dialog = await openGalleryDialog(page);
	for (let name of ["Previous image", "Next image"]) {
		let arrow = dialog.getByRole("button", { name });
		let sized = await measure(arrow);
		expect([sized.width, sized.height], name).toEqual([32, 32]);
		expect(sized.radius, name).toBeGreaterThan(1000);
		expect(await restChrome(arrow), name).toMatchObject({
			border: [0, 0, 0, 0],
			shadow: "none",
			outline: "none",
		});
	}
	let close = dialog.locator('[data-slot="dialog-close"]');
	let closeSize = await measure(close);
	expect([closeSize.width, closeSize.height, closeSize.radius]).toEqual([28, 28, 6]);
	// shadcn's ghost button reserves a 1px transparent border (`border border-transparent`).
	expect(await restChrome(close)).toEqual({
		border: [1, 1, 1, 1],
		borderColor: "rgba(0, 0, 0, 0)",
		shadow: "none",
		outline: "none",
	});
});

test("a coarse pointer grows only the hit area: the visible box, border, radius and type do not move", async ({ page }) => {
	let trigger = await openSelector(page);
	let targets = page.locator(TARGETS);
	let count = await targets.count();
	expect(count).toBeGreaterThan(14);
	let fine = [];
	for (let index = 0; index < count; index++) fine.push(await measure(targets.nth(index)));
	// A fine pointer has no invisible target.
	for (let index = 0; index < count; index++) {
		expect(await targets.nth(index).evaluate(node => getComputedStyle(node, "::after").content))
			.toBe("none");
	}

	await page.evaluate(() => document.documentElement.setAttribute("data-plan-coarse-pointer", ""));
	let coarse = [];
	for (let index = 0; index < count; index++) coarse.push(await measure(targets.nth(index)));
	expect(coarse).toEqual(fine);
	for (let index = 0; index < count; index++) {
		let target = targets.nth(index);
		let after = await target.evaluate(node => {
			let style = getComputedStyle(node, "::after");
			return { content: style.content, width: style.width, height: style.height };
		});
		expect(after.content).toBe('""');
		let box = fine[index]!;
		// `max(100%, 44px)` of the padding box: as big as the control inside its border, and 44px at least.
		let inside = (size: number, edges: number) => Math.max(size - edges, 44);
		expect(Number.parseFloat(after.width)).toBeCloseTo(
			inside(box.width, box.border[1] + box.border[3]),
			1,
		);
		expect(Number.parseFloat(after.height)).toBeCloseTo(
			inside(box.height, box.border[0] + box.border[2]),
			1,
		);
	}

	// The effort levels are 24px tall: a touch 8px above or below one still lands on it, through its
	// target. The popup may settle somewhere else as the page changes, so each aim reads the live box.
	let radio = effortRadios(page).first();
	let own = await radio.textContent();
	let aim = async (offset: "above" | "below") => {
		let box = (await radio.boundingBox())!;
		expect(box.height).toBeLessThan(44);
		let y = offset === "above" ? box.y - 8 : box.y + box.height + 8;
		return page.evaluate(([px, py]) => {
			let hit = document.elementFromPoint(px!, py!);
			return hit?.closest('[role="radio"]')?.textContent ?? hit?.tagName ?? null;
		}, [box.x + box.width / 2, y]);
	};
	expect(await aim("above")).toBe(own);
	expect(await aim("below")).toBe(own);
	await page.evaluate(() => document.documentElement.removeAttribute("data-plan-coarse-pointer"));
	expect(await aim("above")).not.toBe(own);
	expect(await aim("below")).not.toBe(own);
	await expect(trigger).toBeVisible();
});

test("Chopin's global button behaviour does not reach a copy: its press, transition and focus ring are its own", async ({ page }) => {
	let trigger = plate(page, "assistant-ui").getByRole("combobox").first();
	let style = await trigger.evaluate(node => {
		let computed = getComputedStyle(node);
		return { transition: computed.transitionProperty, scale: computed.scale };
	});
	// `transition-colors` in the copy, not Chopin's `transition: scale`.
	expect(style.transition).toContain("color");
	expect(style.transition).not.toBe("scale");
	await trigger.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	let ring = await trigger.evaluate(node => {
		let computed = getComputedStyle(node);
		return { outlineStyle: computed.outlineStyle, shadow: computed.boxShadow };
	});
	// assistant-ui draws a 1px ring in `box-shadow`; Chopin's 2px outline is not added beside it.
	expect(ring.outlineStyle).toBe("none");
	expect(ring.shadow).not.toBe("none");
});

/**
 * The message box is Chopin's own, in Slack's proportions as built: an 8px box with a hairline, a
 * toolbar and a row of 28px ghost buttons with Slack's 18px icons, and a 28px rounded-square send. It is
 * measured where Chat draws it, on the chat plate of the audit.
 */
test("the message box is an 8px box with a 1px border, 28px controls with 18px icons and a 28px rounded-square send, under both pointers", async ({ page }) => {
	let composer = plate(page, "chat").locator(".chat-composer").first();
	await composer.scrollIntoViewIfNeeded();
	let box = composer.locator(".composer-surface");
	let boxed = await measure(box);
	expect(boxed.radius).toBe(8);
	expect(boxed.border).toEqual([1, 1, 1, 1]);

	let controls = composer.locator(".composer-format button, .composer-row .btn-icon");
	let icons = controls.locator("svg:not([data-send-stop-status])");
	expect(await controls.count()).toBeGreaterThanOrEqual(10);
	let sized = async () => {
		let found = [];
		for (let index = 0; index < await controls.count(); index++) {
			let control = controls.nth(index);
			if (!await control.isVisible()) continue;
			let size = await measure(control);
			expect([size.width, size.height], `control ${index} size`).toEqual([28, 28]);
			found.push(size);
		}
		return found;
	};
	let fine = await sized();
	for (let index = 0; index < await icons.count(); index++) {
		let icon = icons.nth(index);
		if (!await icon.isVisible()) continue;
		expect(
			await icon.evaluate(
				node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height],
			),
			`icon ${index}`,
		).toEqual([18, 18]);
	}
	let send = composer.locator("[data-send-stop]");
	let rounded = await measure(send);
	// A rounded square, not a circle: Chopin's medium radius.
	expect(rounded.radius).toBe(6);
	expect(rounded.border).toEqual([0, 0, 0, 0]);

	for (let index = 0; index < fine.length; index++) {
		let visible = [];
		for (let item = 0; item < await controls.count(); item++) {
			if (await controls.nth(item).isVisible()) visible.push(item);
		}
		expect(
			await controls.nth(visible[index]!).evaluate(node =>
				getComputedStyle(node, "::after").content
			),
			`control ${index} has no target on a fine pointer`,
		).toBe("none");
	}
	// A coarse pointer grows only the target, to 44px: the boxes, border and icons do not move.
	await page.evaluate(() => document.documentElement.setAttribute("data-plan-coarse-pointer", ""));
	expect(await sized()).toEqual(fine);
	let after = await send.evaluate(node => {
		let style = getComputedStyle(node, "::after");
		return [style.content, Number.parseFloat(style.width), Number.parseFloat(style.height)];
	});
	expect(after).toEqual(['""', 44, 44]);
});

/**
 * Where Chat docks it the box is set as Slack's message box (the maintainer's approved mock-up and
 * Slack's `p-message_pane_input`): 16px from the pane's sides and foot, a 36px formatting strip and
 * a 36px row of 28px buttons 4px by 6px in, and one line of draft at rest, 8px above and below it
 * and 12px in, in the message's own type. A hovered message's shade is the pane's whole width.
 */
test("the docked box is 16px from the pane's sides and foot with one line of draft 8px by 12px in, and a hovered row is shaded across the whole pane", async ({ page }) => {
	let stage = plate(page, "chat").locator(".design-audit-chat-stage");
	await stage.scrollIntoViewIfNeeded();
	let pane = (await stage.locator(".workspace-chat-panel").boundingBox())!;
	let box = (await stage.locator(".composer-surface").boundingBox())!;
	expect(box.x - pane.x).toBe(16);
	expect(pane.x + pane.width - (box.x + box.width)).toBe(16);
	expect(pane.y + pane.height - (box.y + box.height)).toBe(16);

	let draft = stage.locator(".composer-draft-input");
	let typed = await draft.evaluate(node => {
		let style = getComputedStyle(node);
		let probe = document.createElement("span");
		probe.style.fontSize = "var(--text-base)";
		node.closest(".design-audit-chat-stage")!.append(probe);
		let body = getComputedStyle(probe).fontSize;
		probe.remove();
		return {
			padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
				.map(value => Number.parseFloat(value)),
			line: Number.parseFloat(style.lineHeight),
			height: node.getBoundingClientRect().height,
			fontSize: style.fontSize,
			body,
		};
	});
	expect(typed.padding).toEqual([8, 12, 8, 12]);
	// One line with its padding, held on a whole pixel by the rounded minimum, or the line itself
	// where that rounds down (layout snaps a box to sixty-fourths of a pixel).
	expect(typed.height).toBe(
		Math.max(Math.round(typed.line + 16), Math.round((typed.line + 16) * 64) / 64),
	);
	// The document body's role, which messages are written in.
	expect(typed.fontSize).toBe(typed.body);

	let row = await measure(stage.locator(".composer-row"));
	expect(row.padding).toEqual([4, 6, 4, 6]);
	let strip = stage.locator(".composer-format");
	if (await strip.isVisible()) {
		let format = await measure(strip);
		expect(format.padding).toEqual([4, 6, 4, 6]);
		expect(format.height).toBe(37);
	}

	// Scrolled to its end, the transcript's last entry ends 20px above the box.
	let clearance = await stage.locator("[data-chat-scroll]").evaluate((node, top) => {
		node.scrollTo({ top: node.scrollHeight });
		let entries = [...node.querySelectorAll("[data-chat-stack] > *")].filter(entry =>
			getComputedStyle(entry).position !== "absolute"
			&& entry.getBoundingClientRect().height > 4
		);
		return top - entries.at(-1)!.getBoundingClientRect().bottom;
	}, box.y);
	expect(clearance).toBe(20);

	// The hovered row's shade reaches both edges of the scroller, which spans the pane.
	let scroller = stage.locator("[data-chat-scroll]");
	let body = stage.locator(".chat-message-body").last();
	await body.hover();
	let shade = await body.evaluate(node => {
		let style = getComputedStyle(node, "::before");
		let box = node.getBoundingClientRect();
		return {
			left: box.left + Number.parseFloat(style.left),
			width: Number.parseFloat(style.width),
			radius: style.borderTopLeftRadius,
		};
	});
	let lane = await scroller.evaluate(node => ({
		left: node.getBoundingClientRect().left + node.clientLeft,
		width: node.clientWidth,
		outer: node.getBoundingClientRect().width,
	}));
	expect(lane.outer).toBe(pane.width);
	expect(shade.left).toBe(lane.left);
	expect(shade.width).toBe(lane.width);
	expect(shade.radius).toBe("0px");
});

/**
 * The slots the box fills from the hooks: the `+` is one of its 28px ghost buttons, the files it
 * stages (assistant-ui's chips) and the voice it listens with sit inside the box above the text, and
 * the microphone (assistant-ui's own 32px round button) is in the bottom row with the other controls.
 */
test("the + is a 28px ghost button in the row; the staged files and the voice are inside the box above the text; the microphone is in the row", async ({ page }) => {
	let staged = plate(page, "chat").locator(".chat-composer").filter({
		has: page.locator(".composer-staging [data-slot='composer-attachment']"),
	}).first();
	await staged.scrollIntoViewIfNeeded();
	let box = (await staged.locator(".composer-surface").boundingBox())!;
	let row = (await staged.locator(".composer-row").boundingBox())!;
	let field = (await staged.locator(".composer-field").boundingBox())!;

	let plus = staged.getByRole("button", { name: "Add files", exact: true });
	await expect(plus).toBeVisible();
	let sized = await measure(plus);
	expect([sized.width, sized.height]).toEqual([28, 28]);
	expect(sized.radius).toBe(6);
	expect(
		await plus.locator("svg").evaluate(node => [node.clientWidth, node.clientHeight]),
	).toEqual([18, 18]);
	let at = (await plus.boundingBox())!;
	expect(at.y).toBeGreaterThanOrEqual(row.y);
	expect(at.y + at.height).toBeLessThanOrEqual(row.y + row.height);

	// The chips are in the box, above the field, and below nothing else of the draft's.
	let chips = staged.locator(".composer-staging [data-slot='composer-attachment']");
	expect(await chips.count()).toBe(3);
	for (let index = 0; index < 3; index++) {
		let chip = (await chips.nth(index).boundingBox())!;
		expect(chip.x, `chip ${index} is inside the box`).toBeGreaterThanOrEqual(box.x);
		expect(chip.x + chip.width, `chip ${index} is inside the box`).toBeLessThanOrEqual(
			box.x + box.width + 0.5,
		);
		expect(chip.y + chip.height, `chip ${index} is above the text`).toBeLessThanOrEqual(field.y);
	}

	// The microphone is the element's own 32px round button, in the row beside the other controls.
	let mic = staged.getByRole("button", { name: "Dictate", exact: true });
	let round = await measure(mic);
	expect([round.width, round.height]).toEqual([32, 32]);
	expect(round.radius).toBeGreaterThan(1000);
	let micAt = (await mic.boundingBox())!;
	expect(micAt.y).toBeGreaterThanOrEqual(row.y);
	expect(micAt.y + micAt.height).toBeLessThanOrEqual(row.y + row.height);
	expect(micAt.x).toBeGreaterThan(at.x);

	// Listening shows the element's voice above the text, 44px tall, with its clock in whole minutes.
	let listening = plate(page, "chat").locator(".chat-composer").filter({
		has: page.locator("[data-slot='composer-voice']"),
	}).first();
	await listening.scrollIntoViewIfNeeded();
	let voice = listening.locator("[data-slot='composer-voice']");
	let heard = (await voice.boundingBox())!;
	expect(heard.height).toBe(44);
	expect(heard.y + heard.height).toBeLessThanOrEqual(
		(await listening.locator(".composer-field").boundingBox())!.y,
	);
	await expect(voice).toContainText("1:05");
	await expect(voice).toHaveAttribute("data-recording", "true");
});
