import { expect, ready, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator, Page } from "@playwright/test";

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function chatRatio(page: Page): Promise<number> {
	let [pane, frame] = await Promise.all([
		box(chatPane(page)),
		box(page.locator(".workspace-frame")),
	]);
	return pane.width / frame.width;
}

test("desktop Chat sits before the document at 40% of the available workspace", async ({ join, page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await join("ana");
	let chat = chatPane(page);
	let document = page.locator("main");

	for (let width of [1280, 1440]) {
		await page.setViewportSize({ width, height: 800 });
		await expect.poll(() => chatRatio(page)).toBeCloseTo(0.4, 1);
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

test("the Chat edge grows right, stays beside its reopen control, and remembers its ratio", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let chat = chatPane(page);
	let handle = page.getByRole("separator", { name: "Resize chat" });
	let initial = await box(chat);

	await page.mouse.move(initial.x + initial.width - 2, initial.y + initial.height / 2);
	await page.mouse.down();
	await page.mouse.move(initial.x + initial.width + 38, initial.y + initial.height / 2, {
		steps: 4,
	});
	await page.mouse.up();
	await expect.poll(async () => (await box(chat)).width).toBeGreaterThan(initial.width + 30);
	let pointerWidth = (await box(chat)).width;

	await handle.press("ArrowRight");
	await expect.poll(async () => (await box(chat)).width).toBeGreaterThan(pointerWidth);
	let rememberedRatio = await chatRatio(page);
	let frame = await box(page.locator(".workspace-frame"));

	await page.getByRole("button", { name: "Hide chat pane" }).click();
	await expect(chat).toBeHidden();
	let opener = page.getByRole("button", { name: "Show chat pane" });
	let openerBox = await box(opener);
	expect(openerBox.x).toBeGreaterThanOrEqual(frame.x);
	expect(openerBox.x - frame.x).toBeLessThan(32);
	let controlsBox = await box(page.getByRole("group", { name: "Document view" }));
	expect(controlsBox.x).toBeGreaterThanOrEqual(openerBox.x + openerBox.width);
	await opener.click();
	await expect(chat).toBeVisible();

	await page.getByRole("button", { name: "Collapse Projects sidebar" }).click();
	await expect.poll(() => chatRatio(page)).toBeCloseTo(rememberedRatio, 1);
	await expectNoHorizontalOverflow(page);

	await page.reload();
	await ready(page);
	await expect.poll(() => chatRatio(page)).toBeCloseTo(rememberedRatio, 1);
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect.poll(() => chatRatio(page)).toBeCloseTo(rememberedRatio, 1);
	await expectNoHorizontalOverflow(page);
});
