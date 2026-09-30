import { expect, test } from "@playwright/test";
import { analysis, inspect, load, message, prepareAnalysisHost } from "./analysis-host-native";
test.beforeAll(prepareAnalysisHost);

test("whole message hover shares one portal owner and Escape returns native focus", async ({ page }) => {
	let errors = await load(page);
	await message(page, "host-review").scrollIntoViewIfNeeded();
	await message(page, "host-review").hover();
	await expect(analysis(page, "host-review")).toBeVisible();
	await message(page, "host-retry").hover();
	await expect(analysis(page, "host-retry")).toBeVisible();
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(1);
	await expect(analysis(page, "host-review")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(0);
	await expect(
		message(page, "host-retry").getByRole("button", {
			name: "Analysis for message: failed",
			exact: true,
		}),
	).toBeFocused();
	await page.waitForTimeout(180);
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("keyboard-only inspect opens real diagnostics and pinned message survives pointer leave", async ({ page }) => {
	let errors = await load(page);
	await inspect(page, "host-review");
	await page.keyboard.press("Tab");
	await expect(
		analysis(page, "host-review").getByRole("button", { name: "Close analysis", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await message(page, "host-review").locator("[data-chat-message-text]").click();
	await expect(analysis(page, "host-review")).toBeVisible();
	await page.mouse.move(2, 2);
	await page.waitForTimeout(180);
	await expect(analysis(page, "host-review")).toBeVisible();
	let scroll = page.locator(".analysis-host-chat > [data-focus-boundary]");
	let box = await scroll.boundingBox();
	await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height - 12);
	await page.mouse.wheel(0, -80);
	await expect.poll(() =>
		scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
	).toBeGreaterThanOrEqual(40);
	await expect(message(page, "host-review")).toBeVisible();
	await expect(message(page, "host-review")).toBeInViewport();
	await expect(analysis(page, "host-review")).toBeVisible();
	let top = await scroll.evaluate(element => element.scrollTop);
	await page.evaluate(() => window.analysisHostFixture.append());
	await expect(message(page, "appended-19")).toBeAttached();
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(top);
	await expect(analysis(page, "host-review")).toBeVisible();
	expect(errors).toEqual([]);
});

test("native selection refuses whole-message pinning and interactive controls remain their own action", async ({ page }) => {
	let errors = await load(page);
	let anchor = message(page, "host-review");
	await anchor.scrollIntoViewIfNeeded();
	await anchor.locator("[data-chat-message-text]").evaluate(element => {
		let selection = window.getSelection()!;
		let range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	});
	// A real selected Range plus a dispatched native click isolates the selection refusal from pointer selection clearing.
	await anchor.locator("[data-chat-message-text]").evaluate(element =>
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
	);
	await page.mouse.move(2, 2);
	await page.waitForTimeout(180);
	await expect(analysis(page, "host-review")).toHaveCount(0);
	await page.evaluate(() => window.getSelection()!.removeAllRanges());
	await anchor.getByRole("button", { name: "Review 1 excerpt", exact: true }).click();
	await expect(analysis(page, "host-review")).toBeVisible();
	await expect(
		analysis(page, "host-review").getByRole("button", { name: "Add to card", exact: true }),
	).toBeFocused();
	expect(errors).toEqual([]);
});

test("measured portal stays above the actual host composer and closes when its anchor scrolls out", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 620 });
	let errors = await load(page);
	await inspect(page, "host-review");
	let panel = await analysis(page, "host-review").boundingBox();
	let composer = await page.locator(".chat-composer").boundingBox();
	let chat = await page.locator(".analysis-host-chat").boundingBox();
	expect(panel).not.toBeNull();
	expect(composer).not.toBeNull();
	expect(chat).not.toBeNull();
	expect(panel!.width).toBeGreaterThan(0);
	expect(panel!.x).toBeGreaterThanOrEqual(Math.max(8, chat!.x + 8));
	expect(panel!.x + panel!.width).toBeLessThanOrEqual(Math.min(382, chat!.x + chat!.width - 8));
	expect(panel!.y + panel!.height).toBeLessThanOrEqual(composer!.y + 1);
	let scroller = page.locator(".analysis-host-chat > [data-focus-boundary]");
	await scroller.evaluate(element => element.scrollTop = 0);
	await expect.poll(() =>
		message(page, "host-review").evaluate(element => {
			let bounds = element.getBoundingClientRect();
			let parent = element.closest("[data-focus-boundary]")!.getBoundingClientRect();
			return bounds.top >= parent.bottom;
		})
	).toBe(true);
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("read-only actual marker diagnostics expose findings but no command retries or editable form", async ({ page }) => {
	let errors = await load(page, "readonly");
	await inspect(page, "host-review");
	await expect(
		analysis(page, "host-review").getByRole("button", { name: "Add to card", exact: true }),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await inspect(page, "host-retry");
	await expect(
		analysis(page, "host-retry").getByRole("button", { name: "Retry analysis", exact: true }),
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await inspect(page, "host-jobs");
	await expect(analysis(page, "host-jobs")).toContainText("Controlled failure before publication.");
	await expect(analysis(page, "host-jobs").getByRole("button", { name: /^Retry .* job$/ }))
		.toHaveCount(0);
	expect(
		await page.evaluate(() => ({
			corrections: window.analysisHostFixture.corrections,
			analyses: window.analysisHostFixture.analyses,
			jobs: window.analysisHostFixture.jobs,
		})),
	).toEqual({ corrections: [], analyses: [], jobs: [] });
	expect(errors).toEqual([]);
});
