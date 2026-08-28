/** Browser coverage for the two-view document shell. */

import { expect, ready, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator, Page } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

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

	await handle.press("End");
	let maximum = await handle.getAttribute("aria-valuemax");
	if (maximum === null) throw new Error("Chat resize handle must expose aria-valuemax");
	await expect(handle).toHaveAttribute(
		"aria-valuenow",
		maximum,
	);
});

test("the compact workspace keeps the document unobstructed", async ({ join, page }) => {
	await page.setViewportSize({ width: 640, height: 800 });
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
	let draft = pane.locator("textarea");
	let header = page.getByRole("banner");
	let heading = page.getByRole("heading", { name: "Chat" });
	let close = page.getByRole("button", { name: "Hide chat pane" });

	await draft.fill("unfinished thought");
	await expect(header.getByRole("button", { name: /chat pane/ })).toHaveCount(0);
	await expect(heading).toBeVisible();
	await expect(close).toBeVisible();
	await expect(close).toHaveAttribute("aria-controls", paneId!);
	await expect(close).toHaveAttribute("aria-expanded", "true");
	await close.click();
	let opener = page.getByRole("button", { name: "Show chat pane" });
	await expect(pane).toBeHidden();
	await expect(opener).toHaveAttribute("aria-controls", paneId!);
	await expect(opener).toHaveAttribute("aria-expanded", "false");
	await expect(opener).toBeFocused();
	await opener.click();
	await expect(heading).toBeFocused();
	await expect(draft).toHaveValue("unfinished thought");
});

test("the chat rail remembers its width and visibility", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");

	await page.getByRole("separator", { name: "Resize chat" }).press("End");
	let pane = chatPane(page);
	let paneId = await pane.getAttribute("id");
	expect(paneId).toBeTruthy();
	let rememberedWidth = (await box(pane)).width;
	let toggle = page.getByRole("button", { name: "Hide chat pane" });
	await expect(toggle).toHaveAttribute("aria-controls", paneId!);
	await toggle.click();
	await expect(pane).toBeHidden();

	await page.reload();
	await ready(page);
	await page.getByRole("button", { name: "Show chat pane" }).click();
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
	await pane.locator("textarea").press("Escape");
	await expect(pane).toBeVisible();
});
