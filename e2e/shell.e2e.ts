/** Browser coverage for the two-view document shell. */

import { expect, ready, test } from "./room";

import type { Locator } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function drawn(handle: Locator): Promise<string> {
	return handle.evaluate(element => getComputedStyle(element, "::after").opacity);
}

test("a drag the browser takes away still puts the bar down", async ({ join, page }) => {
	await join("ana");

	let handle = page.getByRole("separator", { name: "Resize the conversation" });
	let start = await box(handle);

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(start.x + 40, start.y + start.height / 2);
	await expect.poll(() => drawn(handle)).toBe("1");

	await handle.evaluate(element => (element as HTMLElement).releasePointerCapture(1));
	await page.mouse.move(0, 0);
	await page.mouse.up();

	await expect.poll(() => drawn(handle)).toBe("0");
});

test("the conversation rail is the only resizable aside", async ({ join, page }) => {
	await join("ana");

	let rail = page.locator("aside");
	let handle = page.getByRole("separator", { name: "Resize the conversation" });
	await expect(rail).toHaveCount(1);
	await expect(page.getByRole("separator")).toHaveCount(1);
	await expect(handle).toHaveAttribute("aria-valuenow", "280");

	let before = (await box(rail)).width;
	await handle.press("ArrowRight");
	await handle.press("ArrowRight");
	expect((await box(rail)).width - before).toBe(32);

	await handle.press("End");
	await expect(handle).toHaveAttribute("aria-valuenow", "400");
});

test("the document keeps 400 pixels before the conversation takes the deficit", async ({ join, page }) => {
	await page.setViewportSize({ width: 640, height: 800 });
	await join("ana");

	expect((await box(page.locator("main"))).width).toBe(400);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
});

test("chat keeps its draft while hidden", async ({ join, page }) => {
	await join("ana");
	let draft = page.locator("#pane-chat textarea");

	await draft.fill("unfinished thought");
	await page.getByRole("button", { name: "Hide conversation pane" }).click();
	await page.getByRole("button", { name: "Show conversation pane" }).click();
	await expect(draft).toHaveValue("unfinished thought");
});

test("the conversation rail remembers its width and visibility", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");

	await page.getByRole("separator", { name: "Resize the conversation" }).press("End");
	let toggle = page.getByRole("button", { name: "Hide conversation pane" });
	await expect(toggle).toHaveAttribute("aria-controls", "pane-chat");
	await toggle.click();
	await expect(page.locator("#pane-chat")).toBeHidden();

	await page.reload();
	await ready(page);
	await page.getByRole("button", { name: "Show conversation pane" }).click();
	await expect.poll(async () => (await box(page.locator("#pane-chat"))).width).toBe(400);
});
