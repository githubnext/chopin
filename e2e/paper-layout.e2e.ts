/** Browser coverage for the paper layout: Chat on the ground, the document as a sheet. */

import { chatInput, expectChatValue } from "./chat-input";
import { expect, ready, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator, Page } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function root(page: Page) {
	return page.locator('[data-workspace-surface="document"]');
}

function sheet(page: Page) {
	return root(page).locator(".workspace-document-panel");
}

function toolbar(page: Page) {
	return root(page).locator("[data-document-toolbar]");
}

function resolved(page: Page, token: string) {
	return page.evaluate(name => {
		let probe = document.createElement("div");
		probe.style.background = `var(${name})`;
		document.body.append(probe);
		let value = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return value;
	}, token);
}

test("split Chat sits on the ground without a header beside a raised sheet", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let pane = chatPane(page);
	let header = page.getByRole("banner");

	await expect(pane.locator("[data-chat-header]")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Hide chat" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Chat" })).toHaveClass(/sr-only/);
	await expect(pane).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	let field = pane.locator(".chat-composer .field");
	await expect(field).toHaveCSS("box-shadow", "none");
	await expect(field).toHaveCSS("background-color", await resolved(page, "--color-inset"));

	let [rootBox, headerBox, paneBox, sheetBox] = await Promise.all([
		box(root(page)),
		box(header),
		box(pane),
		box(sheet(page)),
	]);
	expect(Math.round(sheetBox.y - rootBox.y)).toBe(12);
	expect(sheetBox.y).toBeLessThan(headerBox.y + headerBox.height);
	expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(sheetBox.x + 1);
	expect(Math.round(paneBox.y)).toBe(Math.round(rootBox.y));
	expect(Math.round(paneBox.x + paneBox.width)).toBe(Math.round(sheetBox.x));
	await expect(sheet(page)).not.toHaveCSS("box-shadow", "none");
});

test("presence sits at the right end of the document tab row", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let people = toolbar(page).getByRole("group", { name: /People here: ana/ });

	await expect(people).toBeVisible();
	await expect(page.getByRole("banner").getByRole("group", { name: /People here:/ }))
		.toHaveCount(0);
	let [peopleBox, barBox, viewsBox] = await Promise.all([
		box(people),
		box(toolbar(page)),
		box(page.getByRole("group", { name: "Document view" })),
	]);
	expect(peopleBox.x).toBeGreaterThan(viewsBox.x + viewsBox.width);
	expect(barBox.x + barBox.width - (peopleBox.x + peopleBox.width)).toBeLessThan(24);
});

test("the document expands and restores Chat from the keyboard and remembers it", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let pane = chatPane(page);
	let paneId = await pane.getAttribute("id");
	let draft = chatInput(pane);
	let expand = toolbar(page).getByRole("button", { name: "Expand document" });
	let views = page.getByRole("group", { name: "Document view" });
	await draft.fill("unfinished thought");

	let [expandBox, viewsBox] = await Promise.all([box(expand), box(views)]);
	expect(expandBox.x + expandBox.width).toBeLessThanOrEqual(viewsBox.x);
	await expect(expand).toHaveAttribute("aria-controls", paneId!);
	await expand.focus();
	await page.keyboard.press("Enter");

	let restore = toolbar(page).getByRole("button", { name: "Show chat" });
	await expect(pane).toBeHidden();
	await expect(restore).toBeFocused();
	await expect(restore).toHaveText("Chat");
	expect(await restore.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await expect(restore).toHaveAttribute("aria-expanded", "false");
	await expect(page.locator(".room-header")).toBeHidden();
	let frame = root(page).locator(".workspace-frame");
	await expect.poll(async () => Math.round((await box(sheet(page))).width))
		.toBe(Math.round((await box(frame)).width));
	await page.keyboard.press("Shift+Tab");
	await expect(page.locator(".room-header :focus")).toHaveCount(0);

	await restore.focus();
	await page.keyboard.press("Enter");
	await expect(pane).toBeVisible();
	await expect(page.getByRole("heading", { name: "Chat" })).toBeFocused();
	await expect(page.locator(".room-header")).toBeVisible();
	await expectChatValue(draft, "unfinished thought");

	await toolbar(page).getByRole("button", { name: "Expand document" }).click();
	await page.reload();
	await ready(page);
	await expect(chatPane(page)).toBeHidden();
	await expect(toolbar(page).getByRole("button", { name: "Show chat" })).toBeVisible();
});

test("reduced motion swaps Chat and the top bar without transitions", async ({ join, page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await toolbar(page).getByRole("button", { name: "Expand document" }).click();
	await expect(chatPane(page)).toBeHidden();
	await expect(root(page).locator(".workspace-header-slot")).toHaveCSS("transition-duration", "0s");
});

test("the expanded sheet clears a collapsed Projects sidebar trigger", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await page.getByRole("button", { name: "Hide sidebar" }).click();
	await toolbar(page).getByRole("button", { name: "Expand document" }).click();
	let trigger = page.getByRole("button", { name: "Show sidebar" });
	let restore = toolbar(page).getByRole("button", { name: "Show chat" });

	await expect.poll(async () => {
		let [a, b] = await Promise.all([box(trigger), box(restore)]);
		return a.x + a.width <= b.x || a.y + a.height <= b.y;
	}).toBe(true);
	await restore.click();
	await expect(chatPane(page)).toBeVisible();
});

test("the resize handle sits on the seam between Chat and the sheet", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let handle = page.getByRole("separator", { name: "Resize chat" });
	let [handleBox, sheetBox] = await Promise.all([box(handle), box(sheet(page))]);

	expect(Math.abs(handleBox.x + handleBox.width - sheetBox.x)).toBeLessThanOrEqual(4);
	let before = (await box(chatPane(page))).width;
	await handle.press("ArrowRight");
	await expect.poll(async () => (await box(chatPane(page))).width).toBeGreaterThan(before);
});

test("compact keeps its header presence and navigation, and split keeps expansion", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await toolbar(page).getByRole("button", { name: "Expand document" }).click();

	await page.setViewportSize({ width: 600, height: 844 });
	let header = page.getByRole("banner");
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Expand document" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Show chat" })).toHaveCount(0);
	await expect(header.getByRole("group", { name: /People here: ana/ })).toBeVisible();
	expect(Math.round((await box(header)).width)).toBe(600);
	await expectNoHorizontalOverflow(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(toolbar(page).getByRole("button", { name: "Show chat" })).toBeVisible();
	await expect(chatPane(page)).toBeHidden();

	await page.setViewportSize({ width: 600, height: 844 });
	await page.getByRole("navigation", { name: "Workspace view" }).getByRole("button", {
		exact: true,
		name: "Chat",
	}).click();
	let compactField = chatPane(page).locator(".chat-composer .field");
	await expect(compactField).toHaveCSS("box-shadow", "none");
	await expect(compactField).toHaveCSS("background-color", await resolved(page, "--color-inset"));
});
