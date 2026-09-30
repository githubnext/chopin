import { expect, test } from "@playwright/test";
import {
	assertCollapseErrors,
	content,
	dialog,
	inline,
	loadCollapse,
	marker,
	prepareCollapse,
	summary,
} from "./collapse-deletion-native";
test.beforeAll(prepareCollapse);
test.afterEach(async ({ page }) => {
	await assertCollapseErrors(page);
});

test("actual decided inline node hides while its list card remains expanded", async ({ page }) => {
	await loadCollapse(page);
	await expect(inline(page)).toBeHidden();
	expect(
		await content(page).locator(':scope > [data-plan-questionnaire="reader-card"]').evaluate(
			element => element.getClientRects().length,
		),
	).toBe(0);
	await expect(summary(page)).toContainText("GitHub Apps");
	await expect(summary(page).getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
	await expect(marker(page)).toBeVisible();
	expect((await page.evaluate(() => window.collapseFixture.snapshot())).cards).toEqual([
		"reader-card",
		"discarded-card",
	]);
});

test("actual presentation transitions through a settled line without deleting the node", async ({ page }) => {
	await loadCollapse(page);
	await page.evaluate(() => window.collapseFixture.status("decided", false));
	await expect(inline(page)).toBeVisible();
	await expect(inline(page)).toContainText("Decided: GitHub Apps");
	await expect(summary(page)).toContainText("GitHub Apps");
	await page.clock.install();
	await page.clock.pauseAt(new Date());
	await page.evaluate(() => window.collapseFixture.status("decided", true));
	await expect(inline(page)).toBeVisible();
	let closing = content(page).locator('[data-decision-collapsing="reader-card"]');
	await expect(closing).toHaveAttribute("inert", "");
	await expect(closing).toHaveAttribute("aria-hidden", "true");
	await page.clock.runFor(260);
	await expect(inline(page)).toBeHidden();
	expect(await page.evaluate(() => window.collapseFixture.signals)).toEqual([{
		kind: "question:presence",
		payload: { id: "reader-card" },
	}]);
	expect((await page.evaluate(() => window.collapseFixture.snapshot())).cards).toContain(
		"reader-card",
	);
});

test("authoritative reopened metadata reveals a fresh draft over the stale decided node", async ({ page }) => {
	await loadCollapse(page);
	await page.evaluate(() => window.collapseFixture.status("reopened"));
	await expect(inline(page)).toBeVisible();
	await expect(inline(page).getByRole("button", { name: /^Save/ })).toBeDisabled();
	await expect(marker(page)).toHaveCount(0);
	await expect(inline(page)).toContainText("GitHub Apps");
	await expect(inline(page)).toContainText("Auth0");
	expect(await page.evaluate(() => window.collapseFixture.requests)).toEqual([]);
});

test("actual reader confirmation Keep makes no request and held discard remains fenced", async ({ page }) => {
	await loadCollapse(page);
	await marker(page).click();
	await dialog(page).getByRole("button", { name: "Discard", exact: true }).click();
	await expect(dialog(page)).toContainText("Discard this decision?");
	await dialog(page).getByRole("button", { name: "Keep it", exact: true }).click();
	expect(await page.evaluate(() => window.collapseFixture.requests)).toEqual([]);
	await dialog(page).getByRole("button", { name: "Discard", exact: true }).click();
	await dialog(page).getByRole("button", { name: "Discard decision", exact: true }).click();
	await expect(dialog(page).getByRole("button", { name: "Discard decision", exact: true }))
		.toBeDisabled();
	expect(await page.evaluate(() => window.collapseFixture.requests)).toEqual([{
		kind: "question:discard",
		payload: { id: "reader-card" },
	}]);
	await page.evaluate(() => window.collapseFixture.settle(false));
	await expect(dialog(page).getByRole("alert")).toContainText("Could not discard");
});

test("real Backspace after a hidden card moves into its linked prose and retains both blocks", async ({ page }) => {
	await loadCollapse(page);
	await content(page).focus();
	await page.evaluate(() => window.collapseFixture.selectAfter());
	await page.keyboard.press("Backspace");
	await page.keyboard.type(" Updated.");
	await expect(content(page)).toContainText("We use GitHub Apps for authentication. Updated.");
	await expect(content(page)).toContainText("Following detail.");
	expect((await page.evaluate(() => window.collapseFixture.snapshot())).cards).toContain(
		"reader-card",
	);
	await expect(marker(page)).toBeVisible();
});

test("actual NodeSelection deletion refuses a protected decided node", async ({ page }) => {
	await loadCollapse(page);
	await content(page).focus();
	let before = await page.evaluate(() => window.collapseFixture.snapshot());
	await page.evaluate(() => window.collapseFixture.selectCard());
	await page.keyboard.press("Backspace");
	let after = await page.evaluate(() => window.collapseFixture.snapshot());
	expect(after.cards).toEqual(before.cards);
	expect(after.text).toBe(before.text);
});

test("native left and right arrows skip the actual discarded node at prose boundaries", async ({ page }) => {
	await loadCollapse(page);
	await content(page).focus();
	await page.evaluate(() => window.collapseFixture.selectAfterDiscarded());
	await page.keyboard.press("ArrowLeft");
	await expect.poll(() => page.evaluate(() => window.collapseFixture.snapshot().selected)).toBe(
		"Following detail.",
	);
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => page.evaluate(() => window.collapseFixture.snapshot().selected)).toBe(
		"After discarded.",
	);
	expect((await page.evaluate(() => window.collapseFixture.snapshot())).cards).toContain(
		"discarded-card",
	);
});

test("read-only actual editor keys and reader controls cannot delete or publish a decision", async ({ page }) => {
	await loadCollapse(page, true);
	let before = await page.evaluate(() => window.collapseFixture.snapshot());
	await content(page).focus();
	await page.keyboard.press("Backspace");
	await page.keyboard.type("Forbidden edit");
	let after = await page.evaluate(() => window.collapseFixture.snapshot());
	expect(after.cards).toEqual(before.cards);
	expect(after.text).toBe(before.text);
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	let prose = content(page).locator("p").first();
	await prose.scrollIntoViewIfNeeded();
	await expect(prose).toBeInViewport();
	await expect(marker(page)).toBeInViewport();
	await marker(page).click();
	await expect(dialog(page).getByRole("button", { name: "Discard", exact: true })).toBeDisabled();
	await expect(dialog(page).getByRole("button", { name: "Reopen", exact: true })).toBeDisabled();
	expect(await page.evaluate(() => window.collapseFixture.requests)).toEqual([]);
});

test("actual noncollapsed range spanning the hidden decided node refuses text deletion", async ({ page }) => {
	await loadCollapse(page);
	await content(page).focus();
	let before = await page.evaluate(() => window.collapseFixture.snapshot());
	await page.evaluate(() => window.collapseFixture.selectAcrossCard());
	expect((await page.evaluate(() => window.collapseFixture.snapshot())).selection).toEqual({
		kind: "range",
		collapsed: false,
	});
	await page.keyboard.press("Backspace");
	let after = await page.evaluate(() => window.collapseFixture.snapshot());
	expect(after.cards).toEqual(["reader-card", "discarded-card"]);
	expect(after.cards).toEqual(before.cards);
	expect(after.text).toBe(before.text);
	await expect(content(page)).toContainText("We use GitHub Apps for authentication.");
	await expect(content(page)).toContainText("Following detail.");
});

test("authoritative reopened metadata releases protection on the same stale decided node", async ({ page }) => {
	await loadCollapse(page);
	await page.evaluate(() => window.collapseFixture.status("reopened"));
	await expect(inline(page)).toBeVisible();
	await content(page).focus();
	await page.evaluate(() => window.collapseFixture.selectCard());
	let before = await page.evaluate(() => window.collapseFixture.snapshot());
	expect(before.selection).toEqual({ kind: "node" });
	expect(before.statuses).toContainEqual({ id: "reader-card", status: "decided" });
	expect(before.cards).toEqual(["reader-card", "discarded-card"]);
	await page.keyboard.press("Backspace");
	await expect.poll(() => page.evaluate(() => window.collapseFixture.snapshot().cards)).toEqual([
		"discarded-card",
	]);
	await expect(content(page)).toContainText("We use GitHub Apps for authentication.");
	await expect(content(page)).toContainText("Following detail.");
	expect(await page.evaluate(() => window.collapseFixture.requests)).toEqual([]);
});

test("actual discarded list credits authoritative resolver over the stale node author", async ({ page }) => {
	await loadCollapse(page);
	await page.evaluate(() => window.collapseFixture.status("discarded", true, "ben"));
	await expect(summary(page)).toContainText("Discarded by @ben");
	await expect(summary(page)).not.toContainText("@ana");
	await expect(inline(page)).toBeHidden();
	await expect(marker(page)).toHaveCount(0);
	expect(await page.evaluate(() => window.collapseFixture.requests)).toEqual([]);
});
