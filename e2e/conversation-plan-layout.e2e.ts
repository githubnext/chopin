import { expect, ready, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator, Page } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

test("desktop Chat retains its width and stays beside the document as the window grows", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	let chat = chatPane(page);
	let document = page.locator("main");
	let initialWidth = (await box(chat)).width;

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
	expect(rememberedWidth).toBeGreaterThanOrEqual(304);
	expect(rememberedWidth).toBeLessThanOrEqual(400);
	let frame = await box(page.locator(".workspace-frame"));

	await page.getByRole("button", { name: "Hide chat pane" }).click();
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

	await page.getByRole("button", { name: "Collapse Projects sidebar" }).click();
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);
	await expectNoHorizontalOverflow(page);

	await page.reload();
	await ready(page);
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect.poll(async () => (await box(chat)).width).toBeCloseTo(rememberedWidth, 0);
	await expectNoHorizontalOverflow(page);
});
