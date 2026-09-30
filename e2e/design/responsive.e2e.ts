import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

test("controls and document content reflow at 200% text size", async ({ page }) => {
	let field = page.getByRole("textbox", { name: "Default", exact: true });
	let originalSize = await field.evaluate(element =>
		parseFloat(getComputedStyle(element).fontSize)
	);
	await page.evaluate(() => document.documentElement.style.fontSize = "200%");
	let enlargedSize = await field.evaluate(element =>
		parseFloat(getComputedStyle(element).fontSize)
	);
	expect(enlargedSize).toBeGreaterThan(originalSize * 1.5);
	for (let id of ["fields", "callouts", "interactive-document-actions"]) {
		let section = plate(page, id);
		await section.scrollIntoViewIfNeeded();
		let width = await section.evaluate(element => ({
			client: element.clientWidth,
			scroll: element.scrollWidth,
		}));
		expect(width.scroll, `${id} must reflow rather than clip text`).toBeLessThanOrEqual(
			width.client + 1,
		);
	}
	await field.fill("Readable at increased text size");
	await expect(field).toHaveValue("Readable at increased text size");
});

test("wide table retains its own scroll lane", async ({ page }) => {
	let table = plate(page, "table");
	await table.scrollIntoViewIfNeeded();
	let lane = table.locator(".design-audit-table-overflow");
	let metrics = await lane.evaluate(element => ({
		client: element.clientWidth,
		scroll: element.scrollWidth,
		overflow: getComputedStyle(element).overflowX,
	}));
	expect(metrics.overflow).toBe("auto");
	expect(metrics.scroll).toBeGreaterThan(metrics.client);
	await lane.focus();
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => lane.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test("code preview keeps a keyboard-reachable scroll lane", async ({ page }, info) => {
	let preview = plate(page, "code").getByRole("group", { name: "Code preview", exact: true })
		.first();
	await expect(preview).toHaveAttribute("tabindex", "0");
	await preview.focus();
	await expect(preview).toBeFocused();
	let metrics = await preview.evaluate(element => ({
		client: element.clientWidth,
		scroll: element.scrollWidth,
	}));
	if (info.project.name === "narrow") {
		expect(metrics.scroll).toBeGreaterThan(metrics.client);
		await page.keyboard.press("ArrowRight");
		await expect.poll(() => preview.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
	}
});
