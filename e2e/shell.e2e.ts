/** Browser coverage for the two-view document shell. */

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

test("an icon button shows its label on keyboard focus", async ({ join }) => {
	let page = await join("ana");
	let addProject = page.getByRole("button", { exact: true, name: "Add project" });
	await addProject.focus();
	let tooltip = page.locator("[data-icon-tooltip]");
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveText("Add project");
	await page.getByRole("button", { name: /^New document in / }).first().focus();
	await expect(tooltip).toHaveText("New document");
	await page.getByRole("button", { name: "Hide sidebar" }).focus();
	await expect(tooltip).toHaveText("Hide sidebar");
	await page.keyboard.press("Tab");
	await expect(tooltip).toBeHidden();
});

test("an icon tooltip remains visible while its button is focused", async ({ join, page }) => {
	await join("ana");
	let addProject = page.getByRole("button", { exact: true, name: "Add project" });
	await addProject.hover();
	await addProject.focus();
	let tooltip = page.locator("[data-icon-tooltip]");
	await expect(tooltip).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(tooltip).toBeVisible();
});

test("an icon tooltip stays hidden after its button is pressed until the pointer returns", async ({ join, page }) => {
	await join("ana");
	let mention = page.getByRole("button", { exact: true, name: "Mention docs" });
	let tooltip = page.locator("[data-icon-tooltip]");
	await mention.hover();
	await expect(tooltip).toBeVisible();
	await mention.click();
	await expect(tooltip).toBeHidden();
	await page.waitForTimeout(600);
	await expect(tooltip).toBeHidden();
	await page.mouse.move(0, 0);
	await mention.hover();
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveText("Mention docs");
});

test("an icon tooltip shows on keyboard focus and hides when its trigger opens a popup", async ({ join, page }) => {
	await join("ana");
	let addProject = page.getByRole("button", { exact: true, name: "Add project" });
	let tooltip = page.locator("[data-icon-tooltip]");
	await addProject.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	await expect(addProject).toBeFocused();
	await expect(tooltip).toBeVisible();
	await addProject.evaluate(button => {
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "true");
	});
	await expect(tooltip).toBeHidden();
});

test("a second icon tooltip opens without the delay once one has shown", async ({ join, page }) => {
	await join("ana");
	let tooltip = page.locator("[data-icon-tooltip]");
	await page.getByRole("button", { exact: true, name: "Add project" }).hover();
	await expect(tooltip).toHaveText("Add project");
	let newDocument = page.getByRole("button", { name: /^New document in / }).first();
	await newDocument.locator("..").hover();
	await newDocument.hover();
	await expect(tooltip).toHaveText("New document", { timeout: 200 });
	await expect(tooltip).toHaveAttribute("data-instant", "");
});

test("an icon tooltip preserves a title updated during hover", async ({ join, page }) => {
	await join("ana");
	let addProject = page.getByRole("button", { exact: true, name: "Add project" });
	await addProject.evaluate(button => button.setAttribute("title", "Original title"));
	await addProject.hover();
	await addProject.evaluate(button => button.setAttribute("title", "Updated title"));
	await page.mouse.move(0, 0);
	await expect(addProject).toHaveAttribute("title", "Updated title");
});

test("a drag the browser takes away still puts the bar down", async ({ join, page }) => {
	await join("ana");

	let handle = page.getByRole("separator", { name: "Resize chat" });
	let start = await box(handle);

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(start.x + 40, start.y + start.height / 2);
	await expect(handle).toHaveAttribute("data-dragging", "true");

	await handle.evaluate(element => (element as HTMLElement).releasePointerCapture(1));
	await page.mouse.move(0, 0);
	await page.mouse.up();

	await expect(handle).not.toHaveAttribute("data-dragging");
});

test("the chat rail has its own resize control", async ({ join, page }) => {
	await join("ana");

	let rail = page.getByRole("complementary", { name: "Chat" });
	let handle = page.getByRole("separator", { name: "Resize chat" });
	await expect(rail).toBeVisible();
	await expect(handle).toBeVisible();
	let beforeValue = Number(await handle.getAttribute("aria-valuenow"));

	let before = (await box(rail)).width;
	await handle.press("ArrowRight");
	await handle.press("ArrowRight");
	expect((await box(rail)).width).toBeGreaterThan(before);
	expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(beforeValue);

	let widened = (await box(rail)).width;
	await handle.press("ArrowLeft");
	expect((await box(rail)).width).toBeLessThan(widened);

	await handle.press("End");
	let maximum = await handle.getAttribute("aria-valuemax");
	if (maximum === null) throw new Error("Chat resize handle must expose aria-valuemax");
	await expect(handle).toHaveAttribute(
		"aria-valuenow",
		maximum,
	);
});

test("the chat rail edge follows the pointer", async ({ join, page }) => {
	await join("ana");

	let rail = page.getByRole("complementary", { name: "Chat" });
	let handle = page.getByRole("separator", { name: "Resize chat" });
	let start = await box(handle);
	let y = start.y + start.height / 2;
	let before = (await box(rail)).width;

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(start.x + 40, y, { steps: 4 });
	let widened = (await box(rail)).width;
	expect(widened).toBeGreaterThan(before);

	await page.mouse.move(start.x - 20, y, { steps: 4 });
	await page.mouse.up();
	expect((await box(rail)).width).toBeLessThan(widened);
});

test("the compact workspace keeps the document unobstructed", async ({ join, page }) => {
	await page.setViewportSize({ width: 499, height: 800 });
	await join("ana");

	await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("split Chat owns its controls and keeps its draft while hidden", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	let pane = chatPane(page);
	let paneId = await pane.getAttribute("id");
	expect(paneId).toBeTruthy();
	let draft = chatInput(pane);
	let header = page.getByRole("banner");
	let heading = page.getByRole("heading", { name: "Chat" });
	let close = page.getByRole("button", { name: "Hide chat" });
	let chatHeader = pane.locator("[data-chat-header]");
	let identity = chatHeader.locator("[data-chat-identity]");

	await draft.fill("unfinished thought");
	await expect(header.getByRole("button", { name: /chat pane/ })).toHaveCount(0);
	await expect(heading).toBeVisible();
	await expect(identity).toBeVisible();
	let [iconBox, headingBox, closeBox] = await Promise.all([
		identity.boundingBox(),
		heading.boundingBox(),
		close.boundingBox(),
	]);
	expect(iconBox!.x + iconBox!.width).toBeLessThan(headingBox!.x);
	expect(closeBox!.x).toBeGreaterThan(headingBox!.x + headingBox!.width);
	await page.mouse.move(0, 0);
	await expect(close).toHaveCSS("opacity", "0");
	await close.focus();
	await expect(close).toHaveCSS("opacity", "1");
	await draft.focus();
	await expect(close).toHaveCSS("opacity", "0");
	await heading.hover();
	await expect(close).toHaveCSS("opacity", "1");
	await close.hover();
	await expect(page.locator("[data-icon-tooltip]")).toHaveText("Hide chat");
	await expect(page.locator("[data-icon-tooltip]")).toBeVisible();
	await expect(close).toHaveAttribute("aria-controls", paneId!);
	await expect(close).toHaveAttribute("aria-expanded", "true");
	await close.click();
	let opener = page.getByRole("button", { name: "Show chat" });
	let toolbar = page.locator("[data-document-toolbar]");
	let documentTab = toolbar.getByRole("button", { name: "Document", exact: true });
	await expect(pane).toBeHidden();
	await expect(opener).toHaveAttribute("aria-controls", paneId!);
	await expect(opener).toHaveAttribute("aria-expanded", "false");
	await expect(opener).toBeFocused();
	let [openerBox, tabBox] = await Promise.all([opener.boundingBox(), documentTab.boundingBox()]);
	expect(openerBox!.x + openerBox!.width).toBeLessThan(tabBox!.x);
	await page.mouse.move(0, 0);
	await opener.evaluate(button => (button as HTMLButtonElement).blur());
	await expect(opener.locator(".chat-toggle-icon-default")).toHaveCSS("opacity", "1");
	await expect(opener.locator(".chat-toggle-icon-sidebar")).toHaveCSS("opacity", "0");
	await opener.hover();
	await expect(opener.locator(".chat-toggle-icon-default")).toHaveCSS("opacity", "0");
	await expect(opener.locator(".chat-toggle-icon-sidebar")).toHaveCSS("opacity", "1");
	await opener.click();
	await expect(heading).toBeFocused();
	await expectChatValue(draft, "unfinished thought");
});

test("split Chat controls remain available to touch", async ({ join }) => {
	let page = await join("ana", { hasTouch: true, viewport: { width: 1280, height: 800 } });
	let pane = chatPane(page);
	let close = pane.getByRole("button", { name: "Hide chat" });
	expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
	await expect(close).toHaveCSS("opacity", "1");
	await close.tap();
	await expect(pane).toBeHidden();
	let opener = page.getByRole("button", { name: "Show chat" });
	await opener.tap();
	await expect(pane).toBeVisible();
});

test("the chat rail remembers its width and visibility", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");

	await page.getByRole("separator", { name: "Resize chat" }).press("End");
	let pane = chatPane(page);
	let paneId = await pane.getAttribute("id");
	expect(paneId).toBeTruthy();
	let rememberedWidth = (await box(pane)).width;
	let toggle = page.getByRole("button", { name: "Hide chat" });
	await expect(toggle).toHaveAttribute("aria-controls", paneId!);
	await toggle.click();
	await expect(pane).toBeHidden();

	await page.reload();
	await ready(page);
	await page.getByRole("button", { name: "Show chat" }).click();
	await expect.poll(async () => (await box(chatPane(page))).width)
		.toBeCloseTo(rememberedWidth, 0);
});

test("compact navigation does not overwrite the desktop chat preference", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");
	await page.getByRole("separator", { name: "Resize chat" }).press("End");
	let pane = chatPane(page);
	let rememberedWidth = (await box(pane)).width;
	await page.setViewportSize({ width: 390, height: 844 });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await nav.getByRole("button", { name: /Chat/ }).click();
	await nav.getByRole("button", { name: "Document" }).click();

	await page.setViewportSize({ width: 1600, height: 800 });
	await expect(pane).toBeVisible();
	await expect.poll(async () => (await box(pane)).width)
		.toBeCloseTo(rememberedWidth, 0);
});

test("Escape leaves a persistent split Chat pane open", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	let pane = chatPane(page);
	await chatInput(pane).press("Escape");
	await expect(pane).toBeVisible();
});
