import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/diagram-gallery");
	await expect(page.locator("[data-diagram-gallery]")).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
});

test("decorative chart strokes do not open connection details", async ({ page }) => {
	await page.getByRole("navigation", { name: "Diagram types" })
		.getByRole("button", { name: "Line", exact: true }).click();
	let preview = page.locator("[data-catalogue-preview]");
	await expect(preview.locator('[data-sc-edge="s0"]')).toBeVisible();
	await preview.locator('[data-sc-edge="s0"] circle').first().click({ force: true });
	await expect(preview.getByRole("complementary", { name: "Diagram details" })).toHaveCount(0);
});

test("document views use separate SVG resources and survive source changes", async ({ page }) => {
	await expect(page.locator('[role="document"] .plan-document [data-specimen-diagram]'))
		.toHaveCount(2);
	let first = page.locator('[data-specimen-diagram="first"]');
	let second = page.locator('[data-specimen-diagram="second"]');
	await expect(first.locator(".ch-diagram svg")).toBeVisible();
	await expect(second.locator(".ch-diagram svg")).toBeVisible();
	let resources = await page.evaluate(() => {
		let first = document.querySelector('[data-specimen-diagram="first"] svg');
		let second = document.querySelector('[data-specimen-diagram="second"] svg');
		return {
			first: first ? [...first.querySelectorAll("[id]")].map(element => element.id) : [],
			second: second ? [...second.querySelectorAll("[id]")].map(element => element.id) : [],
		};
	});
	expect(resources.first.length).toBeGreaterThan(0);
	expect(resources.second.length).toBeGreaterThan(0);
	expect(resources.first.filter(id => resources.second.includes(id))).toEqual([]);
	let firstNode = first.locator("[data-sc-node]").first();
	await expect(firstNode).toHaveAttribute("role", "button");
	await firstNode.focus();
	await expect(firstNode).toBeFocused();
	await firstNode.press("Enter");
	await expect(first.getByRole("complementary", { name: "Diagram details" })).toBeVisible();
	await expect(second.getByRole("complementary", { name: "Diagram details" })).toHaveCount(0);
	await first.getByRole("button", { name: "Next step" }).click();
	await expect(first.locator(".ch-diagram__status")).toContainText("Step 1 of");
	let future = await first.evaluate(element => {
		let items = [...element.querySelectorAll<SVGElement>("[data-sc-node], [data-sc-edge]")];
		return items.filter(item => item.closest('[data-sc-step][aria-hidden="true"]'))
			.map(item => item.getAttribute("tabindex"));
	});
	expect(future.length).toBeGreaterThan(0);
	expect(future.every(tabIndex => tabIndex === "-1")).toBe(true);

	await page.getByRole("button", { name: "Replace first source" }).click();
	await expect(first).toContainText("State · first instance");
	await expect(first.locator(".ch-diagram__status")).toHaveCount(0);
	await expect(second).toContainText("Sequence · second instance");
	await page.getByRole("button", { name: "Unmount second diagram" }).click();
	await expect(second).toHaveCount(0);
	await expect(page.getByText("Second diagram unmounted.", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Mount second diagram" }).click();
	await expect(second.locator(".ch-diagram svg")).toBeVisible();
});

test("gallery has no page-level horizontal overflow", async ({ page }) => {
	let widths = await page.evaluate(() => {
		return {
			viewport: document.documentElement.clientWidth,
			content: document.documentElement.scrollWidth,
		};
	});
	expect(widths.viewport).toBeGreaterThan(0);
	expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1);
});

test("a narrow diagram exposes keyboard horizontal scrolling", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== "narrow", "The document-width view fits at wide widths.");
	let stage = page.locator('[data-specimen-diagram="first"] .ch-diagram__stage');
	await expect(stage).toHaveAttribute("tabindex", "0");
	await expect(stage).toHaveAttribute("aria-label", /scroll horizontally/i);
	await expect(page.locator('[data-specimen-diagram="first"]')).toContainText(
		/left and right arrow keys/i,
	);
	await stage.focus();
	await expect(stage).toBeFocused();
	await stage.press("ArrowRight");
	await expect.poll(() => stage.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test("reduced motion leaves diagram content readable", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(page.locator('[data-specimen-diagram="first"] .ch-diagram svg')).toBeVisible();
	await expect(page.locator('[data-specimen-diagram="first"]'))
		.not.toContainText("Replay");
});
