import { expect, test } from "@playwright/test";
import {
	assertReaderErrors,
	dialog,
	loadReader,
	marker,
	prepareReader,
	reader,
	tooltip,
} from "./decision-reader-native";
test.beforeAll(prepareReader);
test.afterEach(async ({ page }) => {
	await assertReaderErrors(page);
});

test("real paragraph hover previews its anchored decision and Escape suppresses stationary hover", async ({ page }) => {
	let errors = await loadReader(page);
	let prose = reader(page).getByText("We use GitHub Apps for authentication.", { exact: true });
	await prose.hover();
	await expect(tooltip(page)).toBeVisible();
	await expect(tooltip(page)).toContainText("Auth0");
	await expect(tooltip(page).locator('[data-chosen="true"]')).toContainText("GitHub Apps");
	await page.keyboard.press("Escape");
	await expect(tooltip(page)).toHaveCount(0);
	await page.waitForTimeout(180);
	await expect(tooltip(page)).toHaveCount(0);
	await page.mouse.move(2, 2);
	await prose.hover();
	await expect(tooltip(page)).toBeVisible();
	expect(errors).toEqual([]);
});

test("native marker keyboard pin focuses Close and Escape restores the same marker", async ({ page }) => {
	await loadReader(page);
	await marker(page).focus();
	await expect(tooltip(page)).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(dialog(page)).toBeVisible();
	await expect(dialog(page).getByRole("button", { name: "Close", exact: true })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog(page)).toHaveCount(0);
	await expect(marker(page)).toBeFocused();
});

test("read-only reader forwards the source callback without granting mutation", async ({ page }) => {
	await loadReader(page);
	await marker(page).click();
	await expect(dialog(page).getByRole("button", { name: "Reopen", exact: true })).toBeDisabled();
	await expect(dialog(page).getByRole("button", { name: "Discard", exact: true })).toBeDisabled();
	await dialog(page).getByRole("button", { name: "Show source in chat", exact: true }).click();
	expect(await page.evaluate(() => window.decisionReaderFixture.sources)).toEqual([
		"0:reader-card",
	]);
	expect(await page.evaluate(() => window.decisionReaderFixture.requests)).toEqual([]);
});

test("actual measured panel clamps inside a narrow document host", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 620 });
	await loadReader(page);
	await marker(page).click();
	await expect(dialog(page)).toBeVisible();
	let host = await reader(page).boundingBox();
	let panel = await dialog(page).boundingBox();
	expect(panel!.width).toBeGreaterThan(0);
	expect(panel!.x).toBeGreaterThanOrEqual(host!.x);
	expect(panel!.x + panel!.width).toBeLessThanOrEqual(host!.x + host!.width);
	expect(panel!.y).toBeGreaterThanOrEqual(host!.y);
	expect(panel!.y + panel!.height).toBeLessThanOrEqual(host!.y + host!.height);
});

test("pin survives pointer leave, follows native scroll and retires offscreen", async ({ page }) => {
	await loadReader(page);
	await marker(page).click();
	await page.mouse.move(2, 2);
	await page.waitForTimeout(180);
	await expect(dialog(page)).toBeVisible();
	let before = await marker(page).boundingBox();
	let scroll = reader(page).locator("[data-plan-scroll]");
	await scroll.evaluate(element => element.scrollTop = 30);
	await expect.poll(async () => (await marker(page).boundingBox())!.y).toBeLessThan(before!.y);
	await expect(dialog(page)).toBeVisible();
	await scroll.evaluate(element => element.scrollTop = element.scrollHeight);
	await expect(marker(page)).toHaveCount(0);
	await expect(dialog(page)).toHaveCount(0);
});

test("hidden host retires reader intent and unmount clears its actual wash", async ({ page }) => {
	await loadReader(page);
	await marker(page).click();
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decided")?.size ?? 0)).toBe(
		1,
	);
	await reader(page).evaluate(element => element.setAttribute("hidden", ""));
	await expect(dialog(page)).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decided")?.size ?? 0)).toBe(
		0,
	);
	await reader(page).evaluate(element => element.removeAttribute("hidden"));
	await expect(marker(page)).toBeVisible();
	await expect(dialog(page)).toHaveCount(0);
	await marker(page).click();
	await expect(dialog(page)).toBeVisible();
	await page.evaluate(() => window.decisionReaderFixture.unmount());
	expect(await page.evaluate(() => CSS.highlights.has("plan-decided"))).toBe(false);
});

test("two actual editors union their wash while a new reader owns only one pin", async ({ page }) => {
	await loadReader(page, true, 2);
	await marker(page, 0).click();
	await marker(page, 1).hover();
	await expect(tooltip(page, 1)).toBeVisible();
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decided")?.size ?? 0)).toBe(
		2,
	);
	await marker(page, 1).click();
	await expect(dialog(page, 1)).toBeVisible();
	await expect(dialog(page, 0)).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decided")?.size ?? 0)).toBe(
		1,
	);
});

test("actual mutation is duplicate-fenced and rejected old intent cannot paint a new dialog", async ({ page }) => {
	await loadReader(page, false);
	await marker(page).click();
	await dialog(page).getByRole("button", { name: "Reopen", exact: true }).click();
	await expect(dialog(page).getByRole("button", { name: "Reopen", exact: true })).toBeDisabled();
	await dialog(page).getByRole("button", { name: "Reopen", exact: true }).evaluate(element =>
		(element as HTMLButtonElement).click()
	);
	expect(await page.evaluate(() => window.decisionReaderFixture.requests)).toEqual([{
		reader: 0,
		kind: "question:reopen",
		payload: { id: "reader-card" },
	}]);
	await page.keyboard.press("Escape");
	await expect(dialog(page)).toHaveCount(0);
	await marker(page).click();
	await expect(dialog(page)).toBeVisible();
	await page.evaluate(() => window.decisionReaderFixture.settle(false));
	await expect(dialog(page).getByRole("button", { name: "Reopen", exact: true })).toBeEnabled();
	await expect(dialog(page).getByRole("alert")).toHaveCount(0);
});
