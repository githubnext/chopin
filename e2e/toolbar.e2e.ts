/**
 * The two things that appear because of where the caret is.
 *
 * Both are placed by measurement against a live rectangle, so neither can be
 * covered by `bun test` — `bubble.test.ts` and `slash.test.ts` cover the
 * decisions those measurements feed, and stop at the point where a browser is
 * required. Everything here is on the other side of that line.
 */

import { content, expect, openIsolatedRoom, test, written } from "./room";
import { expectInsideViewport } from "./responsive";
import { installVisualViewport } from "./visual-viewport";

import type { Browser, Locator, Page } from "@playwright/test";

let MENU = { name: "Insert block" };
let BUBBLE = { name: "Text formatting" };
let LONG_EDITOR = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");

async function emulatedVisualViewportPage(
	browser: Browser,
	baseURL: string,
	room: string,
): Promise<{ close: () => Promise<void>; page: Page }> {
	return openIsolatedRoom(browser, baseURL, room, "ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	}, context =>
		installVisualViewport(context, {
			height: 640,
			offsetLeft: 0,
			offsetTop: 72,
			pageLeft: 0,
			pageTop: 0,
			scale: 1,
			width: 390,
		}));
}

async function expectSurfaceToFollowEditorScroll(
	page: Page,
	surface: Locator,
): Promise<void> {
	// The surface's passive effect owns the scroll listeners; wait one frame so
	// this exercise is about their geometry rather than React effect scheduling.
	await page.waitForTimeout(32);
	let scroller = page.locator("[data-plan-scroll]");
	let beforeScroll = await scroller.evaluate(element => element.scrollTop);
	let beforeRange = await page.evaluate(() =>
		getSelection()!.getRangeAt(0).getBoundingClientRect().top
	);
	await scroller.evaluate(element => {
		element.scrollTop += 72;
	});
	await expect.poll(() => scroller.evaluate(element => element.scrollTop))
		.toBeGreaterThan(beforeScroll + 50);
	await expect.poll(() =>
		page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top)
	).toBeLessThan(beforeRange - 50);
	// Dispatch after the range has its post-scroll layout. This keeps the test
	// deterministic across Chromium's compositor and main-thread scroll paths.
	await scroller.dispatchEvent("scroll");
	await expect.poll(async () => {
		let box = await surface.boundingBox();
		if (!box) return Infinity;
		let range = await page.evaluate(() => {
			let box = getSelection()!.getRangeAt(0).getBoundingClientRect();
			return { bottom: box.bottom, top: box.top };
		});
		return Math.min(
			Math.abs(box.y - range.bottom - 8),
			Math.abs(range.top - box.y - box.height - 8),
		);
	}).toBeLessThan(3);
	await expectInsideViewport(surface);
}

async function insertCallout(page: Page) {
	await content(page).click();
	await page.keyboard.type("/callout");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Callout" }).click();
	return content(page).locator("aside[data-plan-type]");
}

test("filtering resets the option Enter will choose", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/");

	let menu = page.getByRole("listbox", MENU);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.type("call");

	await expect(menu.getByRole("option", { selected: true })).toHaveText("Callout");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("combobox", { name: "Change callout type: Note" })).toBeVisible();
});

test("a callout edits like prose and keeps its type controls out of the way", async ({ join, room }) => {
	let page = await join("ana");
	let callout = await insertCallout(page);
	await expect(callout).toHaveAttribute("data-plan-type", "note");
	let title = callout.getByRole("textbox", { name: "Callout title" });
	let trigger = callout.getByRole("combobox", { name: "Change callout type: Note" });
	await expect(page.getByRole("listbox", { name: "Callout type" })).toHaveCount(0);
	await title.fill("Worth knowing");

	await trigger.click();
	let types = page.getByRole("listbox", { name: "Callout type" });
	await expect(types).toBeVisible();
	await types.getByRole("option", { name: "Warning" }).click();

	await expect(callout).toHaveAttribute("data-plan-type", "warning");
	await expect(title).toHaveText("Worth knowing");
	await written(page, room, /type="warning" title="Worth knowing"/);
});

test("enter twice leaves a legacy callout at the end of the plan", async ({ join, room, seedLegacyCallout }) => {
	await seedLegacyCallout(
		`<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">\n\nKeep this in the callout.\n\n</Callout>`,
	);
	let page = await join("ana");
	let callout = content(page).locator("aside[data-plan-type]");
	let body = callout.locator("[data-plan-body]");
	await expect(body.locator(":scope > p")).toHaveCount(1);

	await expect(body.locator(":scope > p")).toHaveText("Keep this in the callout.");
	await body.locator(":scope > p").evaluate(element => {
		let range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		let selection = getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.press("Enter");
	await expect(body.locator(":scope > p")).toHaveCount(2);
	await page.keyboard.type("Still in it.");
	await page.keyboard.press("Enter");
	await expect(body.locator(":scope > p")).toHaveCount(3);
	await expect(body.locator(":scope > p").last()).toBeEmpty();

	await page.keyboard.press("Enter");
	await expect(body.locator(":scope > p")).toHaveCount(2);
	await page.keyboard.type("Outside the callout.");

	await expect(body.locator(":scope > p")).toHaveCount(2);
	await expect(callout).toContainText("Keep this in the callout.");
	await expect(callout).toContainText("Still in it.");
	await expect(callout).not.toContainText("Outside the callout.");
	await written(
		page,
		room,
		/Keep this in the callout\.[\s\S]*Still in it\.[\s\S]*<\/Callout>[\s\S]*Outside the callout\./,
	);
});

test("escape closes the menu and leaves what was typed", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/tab");
	await expect(page.getByRole("listbox", MENU)).toBeVisible();

	await page.keyboard.press("Escape");

	await expect(page.getByRole("listbox", MENU)).toHaveCount(0);
	await expect(content(page)).toContainText("/tab");
});

test("choosing a table inserts one, with a header", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/table");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Table" }).click();

	await expect(content(page).locator("table")).toHaveCount(1);
	await expect(content(page).locator("th")).toHaveCount(3);
	await expect(content(page).locator("tr")).toHaveCount(3);

	// The query that summoned it has to go: leaving "/table" above the table
	// is the menu writing its own invocation into the document.
	await expect(content(page)).not.toContainText("/table");
});

test("a selection raises exactly one toolbar", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	// Two toolbars is the ported defect: one from the plugin list and one from
	// the surface, stacked, so the top one takes every click and the other is
	// only visible as a shadow slightly out of register.
	await expect(page.getByRole("toolbar", BUBBLE)).toHaveCount(1);
});

test("a mark from the toolbar reaches the file", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	let bubble = page.getByRole("toolbar", BUBBLE);
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await bubble.getByRole("button", { name: "Bold" }).click();
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await written(page, room, /^\*\*Pick a storage format\.\*\*$/m);
});

test("the block type menu converts the block it names", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("What we are building");
	await page.keyboard.press("Shift+Home");

	let bubble = page.getByRole("toolbar", BUBBLE);
	await bubble.getByRole("button", { name: "Block type: Text" }).click();

	// The submenu replaces the toolbar's contents rather than opening beside
	// it, so there is never a second popup to decide between.
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveCount(0);
	await bubble.getByRole("button", { name: "Heading 2" }).click();

	await expect(content(page).getByRole("heading", { level: 2 })).toHaveText(
		"What we are building",
	);
	await written(page, room, /^## What we are building$/m);
});

test("the link prompt refuses a scheme the dialect will not carry", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Read the docs.");
	await page.keyboard.press("Shift+Home");

	let said: string[] = [];
	page.on("dialog", async dialog => {
		said.push(dialog.message());
		await (dialog.type() === "prompt"
			? dialog.accept("javascript:alert(1)")
			: dialog.dismiss());
	});

	await page.getByRole("toolbar", BUBBLE).getByRole("button", { name: "Add link" }).click();

	/*
	 * Refused where the button is, not where the document is. A URL the
	 * dialect rejects applies locally, syncs, and is then refused by the
	 * server — which cannot undo a Yjs transaction, so it rebuilds the room
	 * under a fresh epoch and everybody in it loses their cursors.
	 */
	await expect.poll(() => said).toContain("Only https:, mailto:, relative paths are allowed here.");
	await expect(content(page).locator("a")).toHaveCount(0);

	await written(page, room, /^Read the docs\.$/m);
});

test("touch editor menus use reachable targets and stay inside the viewport", async ({ join }) => {
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});

	await content(page).click();
	await page.keyboard.type("/");
	let menu = page.getByRole("listbox", MENU);
	await expect(menu).toBeVisible();
	let rowHeights = await menu.getByRole("option").evaluateAll(options =>
		options.map(option => option.getBoundingClientRect().height)
	);
	expect(rowHeights.every(height => height >= 44)).toBe(true);
	let menuBox = await menu.boundingBox();
	expect(menuBox).not.toBeNull();
	expect(menuBox!.x).toBeGreaterThanOrEqual(0);
	expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
	expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(844);

	await page.keyboard.press("Escape");
	await content(page).click();
	await page.keyboard.type("Format this selection.");
	await page.keyboard.press("Shift+Home");
	let bubble = page.getByRole("toolbar", BUBBLE);
	await expect(bubble).toBeVisible();
	let targets = await bubble.getByRole("button").evaluateAll(buttons =>
		buttons.map(button => {
			let box = button.getBoundingClientRect();
			return { height: box.height, width: box.width };
		})
	);
	expect(targets.every(target => target.height >= 44 && target.width >= 44)).toBe(true);
	let bubbleBox = await bubble.boundingBox();
	expect(bubbleBox).not.toBeNull();
	expect(bubbleBox!.x).toBeGreaterThanOrEqual(0);
	expect(bubbleBox!.x + bubbleBox!.width).toBeLessThanOrEqual(390);
});

test("an open slash menu follows its caret while the editor scrolls", async ({ baseURL, browser, room, seed }) => {
	await seed(LONG_EDITOR);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let block = content(emulation.page).getByText("Paragraph 9.", { exact: true });
		await block.scrollIntoViewIfNeeded();
		await block.selectText();
		await emulation.page.keyboard.type("/");
		let menu = emulation.page.getByRole("listbox", MENU);
		await expect(menu).toBeVisible();

		await expectSurfaceToFollowEditorScroll(emulation.page, menu);
	} finally {
		await emulation.close();
	}
});

test("an open selection toolbar follows its range while the editor scrolls", async ({ baseURL, browser, room, seed }) => {
	await seed(LONG_EDITOR);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let block = content(emulation.page).getByText("Paragraph 9.", { exact: true });
		await block.scrollIntoViewIfNeeded();
		await block.selectText();
		let bubble = emulation.page.getByRole("toolbar", BUBBLE);
		await expect(bubble).toBeVisible();

		await expectSurfaceToFollowEditorScroll(emulation.page, bubble);
	} finally {
		await emulation.close();
	}
});
