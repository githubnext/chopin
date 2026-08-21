/** Browser coverage for the two-view document shell. */

import { expect, ready, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

test("a drag the browser takes away still puts the bar down", async ({ join, page }) => {
	await join("ana");

	let handle = page.getByRole("separator", { name: "Resize the conversation" });
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

test("the conversation rail has its own resize control", async ({ join, page }) => {
	await join("ana");

	let rail = page.getByRole("complementary", { name: "Conversation" });
	let handle = page.getByRole("separator", { name: "Resize the conversation" });
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
	if (maximum === null) throw new Error("Conversation resize handle must expose aria-valuemax");
	await expect(handle).toHaveAttribute(
		"aria-valuenow",
		maximum,
	);
});

test("the compact workspace keeps the document unobstructed", async ({ join, page }) => {
	await page.setViewportSize({ width: 640, height: 800 });
	await join("ana");

	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("split Conversation owns its controls and keeps its draft while hidden", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	let draft = page.locator("#pane-chat textarea");
	let header = page.getByRole("banner");
	let heading = page.getByRole("heading", { name: "Conversation" });
	let close = page.getByRole("button", { name: "Hide conversation pane" });

	await draft.fill("unfinished thought");
	await expect(header.getByRole("button", { name: /conversation pane/ })).toHaveCount(0);
	await expect(heading).toBeVisible();
	await expect(close).toBeVisible();
	await expect(close).toHaveAttribute("aria-controls", "pane-chat");
	await expect(close).toHaveAttribute("aria-expanded", "true");
	await close.click();
	let opener = page.getByRole("button", { name: "Show conversation pane" });
	await expect(page.locator("#pane-chat")).toBeHidden();
	await expect(opener).toHaveAttribute("aria-controls", "pane-chat");
	await expect(opener).toHaveAttribute("aria-expanded", "false");
	await expect(opener).toBeFocused();
	await opener.click();
	await expect(heading).toBeFocused();
	await expect(draft).toHaveValue("unfinished thought");
});

test("the conversation rail remembers its width and visibility", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");

	await page.getByRole("separator", { name: "Resize the conversation" }).press("End");
	let rememberedWidth = (await box(page.locator("#pane-chat"))).width;
	let toggle = page.getByRole("button", { name: "Hide conversation pane" });
	await expect(toggle).toHaveAttribute("aria-controls", "pane-chat");
	await toggle.click();
	await expect(page.locator("#pane-chat")).toBeHidden();

	await page.reload();
	await ready(page);
	await page.getByRole("button", { name: "Show conversation pane" }).click();
	await expect.poll(async () => (await box(page.locator("#pane-chat"))).width)
		.toBeCloseTo(rememberedWidth, 0);
});

test("compact navigation does not overwrite the desktop conversation preference", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");
	await page.getByRole("separator", { name: "Resize the conversation" }).press("End");
	let rememberedWidth = (await box(page.locator("#pane-chat"))).width;
	await page.setViewportSize({ width: 390, height: 844 });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await nav.getByRole("button", { name: /Conversation/ }).click();
	await nav.getByRole("button", { name: "Document" }).click();

	await page.setViewportSize({ width: 1600, height: 800 });
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect.poll(async () => (await box(page.locator("#pane-chat"))).width)
		.toBeCloseTo(rememberedWidth, 0);
});

test("Escape leaves a persistent split Conversation pane open", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	await page.locator("#pane-chat textarea").press("Escape");
	await expect(page.locator("#pane-chat")).toBeVisible();
});
