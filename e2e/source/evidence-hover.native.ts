import { expect, test } from "@playwright/test";

import {
	card,
	load,
	moveAway,
	open,
	panel,
	prepareEvidence,
	source,
} from "./evidence-hover-native";

test.beforeAll(prepareEvidence);

test("decision evidence stays closed on hover and opens from its summary", async ({ page }) => {
	await load(page);
	await card(page).hover();
	await page.waitForTimeout(450);
	await expect(panel(page)).toHaveCount(0);
	let trigger = card(page).getByRole("button", { name: /^Evidence:/ });
	await expect(trigger).toBeVisible();
	await trigger.click();
	await expect(panel(page)).toBeVisible();
});

test("actual card hover and focus stay closed; button activation and Escape are explicit", async ({ page }) => {
	await load(page);
	await card(page).hover();
	await page.waitForTimeout(450);
	await expect(panel(page)).toHaveCount(0);
	let trigger = card(page).getByRole("button", { name: /^Evidence:/ });
	await trigger.focus();
	await expect(panel(page)).toHaveCount(0);
	await trigger.press("Enter");
	await expect(panel(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(panel(page)).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("actual panel preserves focus after pointer leaves and Escape returns to the card", async ({ page }) => {
	await load(page, true);
	await expect(card(page).getByRole("radio", { name: "GitHub Apps", exact: true })).toBeEnabled();
	await open(page);
	await expect(panel(page).getByText("Supported by mina", { exact: true })).toHaveCount(1);
	await expect(panel(page).getByText("Opposed by lee", { exact: true })).toHaveCount(1);
	await source(page).focus();
	await moveAway(page);
	await page.waitForTimeout(300);
	await expect(panel(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(panel(page)).toHaveCount(0);
	expect(
		await page.evaluate(() =>
			!!document.activeElement?.closest(
				'article[data-plan-sidecar-questionnaire="native-evidence-card"]',
			)
		),
	).toBe(true);
});

test("read-only Source opens the actual Transcript and exact saved quote without writes", async ({ page }) => {
	await load(page);
	await open(page);
	await source(page).click();
	await expect(panel(page)).toHaveCount(0);
	await expect(page.locator('[data-chat-message-id="native-source"]')).toHaveAttribute(
		"data-source-exact",
		"true",
	);
	expect(
		await page.evaluate(() =>
			[...(CSS.highlights.get("conversation-source") ?? [])].map(range => ({
				quote: range.toString(),
				native: range instanceof Range,
			}))
		),
	).toEqual([{ quote: "People already have GitHub accounts.", native: true }]);
	expect(await page.evaluate(() => window.evidenceFixture.writes)).toEqual([]);
});

test("actual Source falls back to the saved quote when current message text changed", async ({ page }) => {
	await load(page);
	await page.evaluate(() =>
		window.evidenceFixture.sourceText("A message changed after the saved excerpt.")
	);
	await open(page);
	await source(page).click();
	await expect(page.locator('[data-chat-message-id="native-source"]')).toHaveAttribute(
		"data-source-exact",
		"false",
	);
	await expect(page.locator('[data-chat-message-id="native-source"]'))
		.toHaveAttribute("data-chat-source", "true");
	expect(await page.evaluate(() => CSS.highlights.get("conversation-source")?.size ?? 0)).toBe(0);
});

for (let intent of ["source", "escape"] as const) {
	test(`narrow overlapping panel does not reopen under a stationary pointer after ${intent}`, async ({ page }) => {
		await page.setViewportSize({ width: 380, height: 480 });
		await load(page);
		await open(page);
		let bounds = await card(page).boundingBox();
		expect(bounds).not.toBeNull();
		if (intent === "source") {
			let button = await source(page).boundingBox();
			expect(button).not.toBeNull();
			// Confirm the source control actually overlaps the card; do not claim suppression otherwise.
			expect(button!.x + button!.width / 2).toBeGreaterThanOrEqual(bounds!.x);
			expect(button!.x + button!.width / 2).toBeLessThan(bounds!.x + bounds!.width);
			expect(button!.y + button!.height / 2).toBeGreaterThanOrEqual(bounds!.y);
			expect(button!.y + button!.height / 2).toBeLessThan(bounds!.y + bounds!.height);
			await source(page).click();
		} else {
			await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
			await page.keyboard.press("Escape");
		}
		await expect(panel(page)).toHaveCount(0);
		await page.waitForTimeout(500);
		await expect(panel(page)).toHaveCount(0);
		await moveAway(page);
		await open(page);
	});
}

test("short viewport clamps evidence, in-view scroll repositions it and offscreen scroll closes it", async ({ page }) => {
	await page.setViewportSize({ width: 560, height: 320 });
	await load(page);
	await page.evaluate(() => window.evidenceFixture.long());
	await open(page);
	let bounds = await panel(page).boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(12);
	expect(bounds!.y).toBeGreaterThanOrEqual(12);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(548);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(308);
	await panel(page).evaluate(element => element.scrollTop = 100);
	expect(await panel(page).evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect(panel(page)).toBeVisible();
	let scroller = page.locator("[data-plan-scroll]");
	await scroller.evaluate(element => element.scrollTop = 60);
	await expect(panel(page)).toBeVisible();
	await scroller.evaluate(element => element.scrollTop = 600);
	await expect(panel(page)).toHaveCount(0);
});

test("live content remains open while terminal metadata, hidden card and empty evidence close cleanly", async ({ page }) => {
	await load(page);
	await open(page);
	await page.evaluate(() => window.evidenceFixture.replace());
	await expect(panel(page)).toBeVisible();
	await expect(panel(page).getByText("Supported by mina, jules", { exact: true })).toHaveCount(1);
	await page.evaluate(() => window.evidenceFixture.status("decided"));
	await expect(panel(page)).toHaveCount(0);
	await page.evaluate(() => window.evidenceFixture.status("reopened"));
	await moveAway(page);
	await open(page);
	await page.evaluate(() => window.evidenceFixture.empty());
	await expect(panel(page)).toHaveCount(0);
	await page.evaluate(() => window.evidenceFixture.hide());
	await expect(card(page)).toHaveCount(0);
	await page.evaluate(() => window.evidenceFixture.unmount());
	await expect(page.locator(".plan-evidence-popover")).toHaveCount(0);
});

test("missing authoritative metadata hides the evidence button", async ({ page }) => {
	await load(page);
	await page.evaluate(() => window.evidenceFixture.status(undefined));
	await card(page).hover();
	await expect(card(page).getByRole("button", { name: /^Evidence:/ })).toHaveCount(
		0,
	);
	await expect(panel(page)).toHaveCount(0);
});
