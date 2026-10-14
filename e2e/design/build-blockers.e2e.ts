import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

test.use({ visualReview: true });

test("named blockers use one row hover surface and no arrow tooltip", async ({ page }) => {
	let trigger = plate(page, "build-blockers").getByRole("button", {
		name: "1 decision left. Show blockers",
		exact: true,
	});
	await trigger.click();
	let popup = page.getByRole("dialog", { name: "Build blockers", exact: true });
	let row = popup.getByRole("button", {
		name: "Review: How should the cache expire?",
		exact: true,
	});
	await expect(row).toBeVisible();
	await expect(popup.getByRole("button")).toHaveCount(1);
	let rest = await row.evaluate(element => getComputedStyle(element).backgroundColor);
	await row.getByText("How should the cache expire?", { exact: true }).hover();
	await expect.poll(() => row.evaluate(element => getComputedStyle(element).backgroundColor)).not
		.toBe(rest);
	await expect(row.locator("svg")).toHaveCount(2);
	await expect(row.locator("button")).toHaveCount(0);
	await row.locator(".build-blocker-arrow").hover();
	await expect(page.getByRole("tooltip")).not.toBeVisible();
	let peer = plate(page, "build-blockers").getByRole("status");
	expect(await row.evaluate(element => getComputedStyle(element).fontSize))
		.toBe(await peer.evaluate(element => getComputedStyle(element).fontSize));
	await row.click();
	await expect(popup).not.toBeVisible();
	await expect(peer).toHaveText("Review: How should the cache expire?");
});

test("blocker keyboard and outside dismissal retain the selected investigation identity", async ({ page }) => {
	let trigger = plate(page, "build-blockers").getByRole("button", {
		name: "2 investigations left. Show blockers",
		exact: true,
	});
	await trigger.focus();
	await trigger.press("Enter");
	let popup = page.getByRole("dialog", { name: "Build blockers", exact: true });
	let first = popup.getByRole("button", { name: "Open: Compare cold-start times", exact: true });
	await expect(first).toBeFocused();
	await first.press("Escape");
	await expect(popup).not.toBeVisible();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.getByRole("heading", { name: "Build blockers", exact: true }).click();
	await expect(popup).not.toBeVisible();
	await trigger.click();
	await popup.getByRole("button", { name: "Open: Measure cache memory usage", exact: true })
		.click();
	await expect(plate(page, "build-blockers").getByRole("status"))
		.toHaveText("Open: Measure cache memory usage");
});

test("hover previews can be pinned by click without closing or stealing focus", async ({ page }) => {
	let trigger = plate(page, "build-blockers").getByRole("button", {
		name: "1 decision left. Show blockers",
		exact: true,
	});
	await trigger.hover();
	let popup = page.getByRole("dialog", { name: "Build blockers", exact: true });
	await expect(popup).toBeVisible();
	await expect(popup.getByRole("button")).not.toBeFocused();
	await trigger.click();
	await page.getByRole("heading", { name: "Build blockers", exact: true }).hover();
	await expect(popup).toBeVisible();
	await page.getByRole("heading", { name: "Build blockers", exact: true }).click();
	await expect(popup).not.toBeVisible();
});

test("connection setup discloses a padded accordion and copies the exact document and command", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	let trigger = plate(page, "build-blockers").getByRole("button", {
		name: "Connect Chopin",
		exact: true,
	});
	await trigger.click();
	let popup = page.getByRole("dialog", { name: "Connect Chopin", exact: true });
	await expect(popup).toBeVisible();
	await expect(popup.getByRole("button", { name: /close/i })).toHaveCount(0);
	await expect(popup.locator("details, summary")).toHaveCount(0);
	let backend = popup.getByLabel("Planner command", { exact: true });
	await expect(backend).not.toBeVisible();
	await popup.getByRole("button", { name: "Copy URL", exact: true }).click();
	await expect(popup.getByRole("status")).toHaveText("URL copied");
	let url = "http://localhost:8787/githubnext/chopin/cache-plan";
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
	let unfold = popup.getByRole("button", { name: "Use the terminal", exact: true });
	let rest = await unfold.evaluate(element => getComputedStyle(element).backgroundColor);
	await unfold.getByText("Use the terminal", { exact: true }).hover();
	await expect.poll(() => unfold.evaluate(element => getComputedStyle(element).backgroundColor))
		.not.toBe(rest);
	let padding = await unfold.evaluate(element => {
		let style = getComputedStyle(element);
		return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
	});
	expect(padding).toEqual([8, 8]);
	await unfold.press("Enter");
	await expect(backend).toBeVisible();
	await expect(unfold).toHaveAttribute("aria-expanded", "true");
	await expect(popup.getByRole("button", { name: "Copy command", exact: true })).toBeDisabled();
	await backend.fill("planner --label='Cache plan'");
	await popup.getByRole("button", { name: "Copy command", exact: true }).click();
	await expect(popup.getByRole("status")).toHaveText("Command copied");
	expect(await page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await popup.locator("pre code").innerText());
	let box = await popup.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
	await page.keyboard.press("Escape");
	await expect(popup).not.toBeVisible();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.getByRole("heading", { name: "Build blockers", exact: true }).click();
	await expect(popup).not.toBeVisible();
});

test("an offline agent offers connection guidance instead of an unexplained retry", async ({ page }) => {
	let specimen = plate(page, "build-blockers");
	await expect(specimen.getByRole("button", { name: "Agent offline", exact: true })).toBeVisible();
	await expect(specimen.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
	await specimen.getByRole("button", { name: "Connect agent", exact: true }).click();
	let popup = page.getByRole("dialog", { name: "Connect agent", exact: true });
	await expect(popup).toContainText(
		"Run this in your project folder, then approve the pairing page.",
	);
	await expect(popup.getByRole("button", { name: "Copy command", exact: true })).toBeEnabled();
	await expect(popup.locator("pre code")).toContainText("CHOPIN_URL=http://localhost:8787");
	await expect(popup.getByRole("button", { name: /close/i })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(popup).not.toBeVisible();
});
