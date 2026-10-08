import { mkdir } from "node:fs/promises";
import { expect, test } from "./room";
import { card, createDecision, openWire, showDecisions, state } from "./visual-decision.helpers";

import type { Page } from "@playwright/test";

async function previewPadding(page: Page) {
	let frame = card(page).frameLocator('iframe[title="Adjusted decision card"]');
	return frame.locator(".question-option").first().evaluate(element =>
		getComputedStyle(element).paddingTop
	);
}

test("one adjusted preview, inspector responsive placement, pointer/Space/accessibility peek and shared Reset", async ({ join, room }) => {
	let ana = await join("ana", { viewport: { width: 1440, height: 1000 } });
	let id = await createDecision(ana);
	await openWire(ana, room);
	await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
	await expect(card(ana).locator("iframe:visible")).toHaveCount(1);
	let preview = card(ana).getByRole("region", { name: "Decision card preview", exact: true });
	let inspector = card(ana).getByRole("complementary", {
		name: "Decision card controls",
		exact: true,
	});
	await expect.poll(async () => {
		let previewBox = (await preview.boundingBox())!;
		let inspectorBox = (await inspector.boundingBox())!;
		return inspectorBox.x > previewBox.x && Math.abs(inspectorBox.y - previewBox.y) < 2;
	}).toBe(true);
	let previewBox = (await preview.boundingBox())!;
	let save = card(ana).getByRole("button", { name: "Save decision", exact: true });
	expect((await save.boundingBox())!.y).toBeLessThan(previewBox.y);
	let slider = card(ana).getByRole("slider", { name: "Option vertical padding", exact: true });
	await slider.focus();
	await ana.keyboard.press("End");
	await card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill(
		"#ABCDEF",
	);
	await expect(save).toBeEnabled();
	await expect.poll(() => previewPadding(ana)).toBe("8px");
	let accepted = await state(ana, id);
	let peek = card(ana).getByRole("button", { name: "Show current", exact: true });
	let box = (await peek.boundingBox())!;
	await ana.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await ana.mouse.down();
	await expect(peek).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => previewPadding(ana)).toBe("6px");
	expect(await state(ana, id)).toEqual(accepted);
	await ana.mouse.move(5, 5);
	await ana.mouse.up();
	await expect(peek).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => previewPadding(ana)).toBe("8px");
	await peek.focus();
	await ana.keyboard.down("Space");
	await expect.poll(() => previewPadding(ana)).toBe("6px");
	await ana.keyboard.up("Space");
	await expect.poll(() => previewPadding(ana)).toBe("8px");
	await peek.evaluate(element => (element as HTMLButtonElement).click());
	await expect(peek).toHaveAttribute("aria-pressed", "true");
	await peek.evaluate(element => (element as HTMLButtonElement).click());
	await expect(peek).toHaveAttribute("aria-pressed", "false");
	await peek.evaluate(element => (element as HTMLButtonElement).click());
	await slider.focus();
	await expect(peek).toHaveAttribute("aria-pressed", "false");
	await peek.focus();
	await ana.keyboard.down("Space");
	await slider.focus();
	await ana.keyboard.up("Space");
	await expect(peek).toHaveAttribute("aria-pressed", "false");

	await mkdir("/private/tmp/chopin-visual-decision-screenshots", { recursive: true });
	await ana.screenshot({
		path: "/private/tmp/chopin-visual-decision-screenshots/wide.png",
		fullPage: true,
	});
	await card(ana).screenshot({
		path: "/private/tmp/chopin-visual-decision-screenshots/wide-card.png",
	});
	await ana.setViewportSize({ width: 390, height: 844 });
	await expect.poll(async () => {
		let previewBox = (await preview.boundingBox())!;
		let inspectorBox = (await inspector.boundingBox())!;
		return inspectorBox.y >= previewBox.y + previewBox.height - 2
			&& Math.abs(inspectorBox.x - previewBox.x) < 2;
	}).toBe(true);
	await expect(card(ana).locator("iframe:visible")).toHaveCount(1);
	expect(await ana.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await ana.screenshot({
		path: "/private/tmp/chopin-visual-decision-screenshots/narrow.png",
		fullPage: true,
	});
	await card(ana).getByRole("button", { name: "Reset", exact: true }).click();
	await expect(save).toBeEnabled();
	await expect.poll(async () => (await state(ana, id)).values).toEqual(
		accepted.definition.baseline,
	);
	await save.click();
	await expect(card(ana)).toContainText("@ana");
	await ana.setViewportSize({ width: 1440, height: 1000 });
	await expect.poll(() => previewPadding(ana)).toBe("6px");
	await ana.reload();
	await showDecisions(ana);
	await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
	await expect.poll(() => previewPadding(ana)).toBe("6px");
	await expect(
		card(ana).frameLocator('iframe[title="Adjusted decision card"]')
			.getByText("How should people sign in to this prototype?", { exact: true }),
	).toBeVisible();
	await expect(card(ana).getByText(/Saved by @ana/)).toBeVisible();
	await ana.screenshot({
		path: "/private/tmp/chopin-visual-decision-screenshots/saved.png",
		fullPage: true,
		animations: "disabled",
	});
	await card(ana).screenshot({
		path: "/private/tmp/chopin-visual-decision-screenshots/saved-card.png",
		animations: "disabled",
	});
});

test("touch press/release and cancellation restore adjusted values without editing the draft", async ({ join, room }) => {
	let ana = await join("ana", { viewport: { width: 390, height: 844 }, hasTouch: true });
	let id = await createDecision(ana);
	await openWire(ana, room);
	await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
	let reply = await state(ana, id);
	let peek = card(ana).getByRole("button", { name: "Show current", exact: true });
	let box = (await peek.boundingBox())!;
	let session = await ana.context().newCDPSession(ana);
	await session.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
	});
	await expect(peek).toHaveAttribute("aria-pressed", "true");
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await expect(peek).toHaveAttribute("aria-pressed", "false");
	await session.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
	});
	await expect(peek).toHaveAttribute("aria-pressed", "true");
	await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
	await expect(peek).toHaveAttribute("aria-pressed", "false");
	expect(await state(ana, id)).toEqual(reply);
	await session.detach();
});
