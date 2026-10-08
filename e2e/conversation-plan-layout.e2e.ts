import { expect, ready, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator, Page } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

test("Chat grows to available space and preserves a preferred width across narrower layouts", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await join("ana");
	let chat = chatPane(page);
	let handle = page.getByRole("separator", { name: "Resize chat" });
	let document = page.locator(".workspace-frame > main");
	await handle.press("End");
	let preferred = Number(await handle.getAttribute("aria-valuemax"));
	expect(preferred).toBeGreaterThan(750);
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(preferred, 0);
	await expect.poll(async () => (await box(document)).width).toBeCloseTo(450, 0);

	await page.setViewportSize({ width: 950, height: 900 });
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(476, 0);
	await expect.poll(() => page.evaluate(() => localStorage.getItem("chopin:pane:chat")))
		.toBe(String(preferred));
	await handle.press("ArrowLeft");
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(460, 0);

	await page.setViewportSize({ width: 1600, height: 900 });
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(460, 0);
	await handle.press("Home");
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(250, 0);
	await page.setViewportSize({ width: 723, height: 900 });
	let navigation = page.getByRole("navigation", { name: "Workspace view" });
	await expect(navigation).toBeVisible();
	await expect(handle).toHaveCount(0);
	let [navigationBox, frameBox] = await Promise.all([
		box(navigation),
		box(page.locator(".workspace-frame")),
	]);
	expect(navigationBox.y + navigationBox.height).toBeLessThanOrEqual(frameBox.y);
	await expectNoHorizontalOverflow(page);
});

test("desktop Chat retains its width and stays beside the document as the window grows", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	let chat = chatPane(page);
	let document = page.locator("main");
	let initialWidth = (await box(chat)).width;
	expect(initialWidth).toBeCloseTo(500, 0);

	for (let width of [1280, 1440]) {
		await page.setViewportSize({ width, height: 800 });
		await expect.poll(async () => (await box(chat)).width).toBeCloseTo(initialWidth, 0);
		let [chatBox, documentBox, frameBox] = await Promise.all([
			box(chat),
			box(document),
			box(page.locator(".workspace-frame")),
		]);
		expect(chatBox.x).toBeCloseTo(frameBox.x, 0);
		expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(documentBox.x + 1);
	}

	await expect(chat).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toBeVisible();
	await expect(page.locator('[aria-label="editable markdown"]')).toBeEditable();
	await expectNoHorizontalOverflow(page);
});

test("the Chat edge grows right, keeps its left-side reopen control, and remembers its width", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let chat = chatPane(page);
	let handle = page.getByRole("separator", { name: "Resize chat" });
	let initial = await box(chat);
	let separator = await box(handle);
	let dragX = separator.x + separator.width / 2;
	let dragY = separator.y + separator.height / 2;

	await page.mouse.move(dragX, dragY);
	await page.mouse.down();
	await page.mouse.move(dragX + 20, dragY, {
		steps: 4,
	});
	await page.mouse.up();
	await expect.poll(async () => (await box(chat)).width).toBeGreaterThan(initial.width + 10);
	expect((await box(chat)).x).toBeCloseTo(initial.x, 0);
	let pointerWidth = (await box(chat)).width;

	await handle.press("ArrowRight");
	await expect.poll(async () => (await box(chat)).width).toBeGreaterThan(pointerWidth);
	let rememberedWidth = (await box(chat)).width;
	expect(rememberedWidth).toBeGreaterThanOrEqual(250);
	expect(rememberedWidth).toBeLessThanOrEqual(Number(await handle.getAttribute("aria-valuemax")));
	let frame = await box(page.locator(".workspace-frame"));

	await page.getByRole("button", { name: "Close sidebar" }).click();
	await expect(chat).toBeHidden();
	let opener = page.getByRole("button", { name: "Show chat pane" });
	let openerBox = await box(opener);
	expect(openerBox.x + openerBox.width).toBeLessThanOrEqual(frame.x + frame.width);
	expect(openerBox.x - frame.x).toBeLessThan(32);
	let controlsBox = await box(page.getByRole("group", { name: "Document view" }));
	expect(openerBox.x + openerBox.width).toBeLessThanOrEqual(controlsBox.x);
	await opener.click();
	await expect(chat).toBeVisible();
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);

	await page.getByRole("button", { name: "Hide sidebar" }).click();
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);
	await expectNoHorizontalOverflow(page);

	await page.reload();
	await ready(page);
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);
	await expectNoHorizontalOverflow(page);
});
