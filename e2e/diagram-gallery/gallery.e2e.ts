import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

async function reload(page: Page) {
	await page.reload();
	await expect(page.locator("[data-diagram-gallery]")).toBeVisible();
}

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
	// Opening on the whole diagram keeps the stepping below independent of playback timing.
	await page.emulateMedia({ reducedMotion: "reduce" });
	await reload(page);
	await expect(page.locator('[role="document"] .plan-document [data-specimen-diagram]'))
		.toHaveCount(2);
	let first = page.locator('[data-specimen-diagram="first"]');
	let second = page.locator('[data-specimen-diagram="second"]');
	await expect(first.locator(".ch-diagram svg.sc-svg")).toBeVisible();
	await expect(second.locator(".ch-diagram svg.sc-svg")).toBeVisible();
	let resources = await page.evaluate(() => {
		let first = document.querySelector('[data-specimen-diagram="first"] svg.sc-svg');
		let second = document.querySelector('[data-specimen-diagram="second"] svg.sc-svg');
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
	let controls = first.getByRole("group", { name: "Diagram controls", exact: true });
	let total = Number(await first.locator("svg.sc-svg").getAttribute("data-sc-steps"));
	await controls.getByRole("button", { name: "Previous step", exact: true }).click();
	await expect(first.locator(".ch-diagram__status")).toContainText(
		`Step ${total - 1} of ${total}`,
	);
	await expect(first.getByRole("complementary", { name: "Diagram details" })).toHaveCount(0);
	let future = await first.evaluate(element => {
		let items = [...element.querySelectorAll<SVGElement>("[data-sc-node], [data-sc-edge]")];
		return items.filter(item => item.closest('[data-sc-step][aria-hidden="true"]'))
			.map(item => item.getAttribute("tabindex"));
	});
	expect(future.length).toBeGreaterThan(0);
	expect(future.every(tabIndex => tabIndex === "-1")).toBe(true);

	await page.getByRole("button", { name: "Replace first source" }).click();
	await expect(first).toContainText("State · first instance");
	// A new source opens fresh, on its whole diagram.
	await expect(first.locator(".ch-diagram__status")).toHaveText(/^Step (\d+) of \1$/);
	await expect(second).toContainText("Sequence · second instance");
	await page.getByRole("button", { name: "Unmount second diagram" }).click();
	await expect(second).toHaveCount(0);
	await expect(page.getByText("Second diagram unmounted.", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Mount second diagram" }).click();
	await expect(second.locator(".ch-diagram svg.sc-svg")).toBeVisible();
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
	await stage.focus();
	await expect(stage).toBeFocused();
	await stage.press("ArrowRight");
	await expect.poll(() => stage.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test("reduced motion opens on the whole diagram and plays only when asked", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await reload(page);
	let first = page.locator('[data-specimen-diagram="first"]');
	let svg = first.locator("svg.sc-svg");
	await expect(svg).toBeVisible();
	let total = Number(await svg.getAttribute("data-sc-steps"));
	let controls = first.getByRole("group", { name: "Diagram controls", exact: true });
	let counter = (step: number) => controls.getByText(`${step} / ${total}`, { exact: true });
	await expect(counter(total)).toBeVisible();
	await page.waitForTimeout(1000);
	await expect(counter(total)).toBeVisible();
	await expect(controls.getByRole("button", { name: "Next step", exact: true })).toBeDisabled();

	await controls.getByRole("button", { name: "Play diagram", exact: true }).click();
	await expect(counter(1)).toBeVisible();
	await expect(svg).toHaveClass(/sc-stepping/);
	await expect(controls.getByRole("button", { name: "Pause diagram", exact: true })).toBeVisible();
	let shown = controls.locator(".ch-diagram__step");
	// Each step shows for one stagger; poll faster than expect's backoff.
	await expect.poll(async () => Number((await shown.textContent())!.split(" / ")[0]), {
		intervals: [50],
	}).toBeGreaterThan(1);
	await controls.getByRole("button", { name: "Restart diagram", exact: true }).click();
	await expect(counter(1)).toBeVisible();
	await expect(first.locator(".ch-diagram__status")).toBeEmpty();
});

test("diagram controls sit centred below the drawing and step to either end", async ({ page }) => {
	let first = page.locator('[data-specimen-diagram="first"]');
	let stage = first.locator(".ch-diagram__stage");
	let controls = first.getByRole("group", { name: "Diagram controls", exact: true });
	await expect(controls).toBeVisible();
	let [stageBox, controlsBox] = [await stage.boundingBox(), await controls.boundingBox()];
	expect(controlsBox!.y).toBeGreaterThanOrEqual(stageBox!.y + stageBox!.height);
	expect(
		Math.abs(
			controlsBox!.x + controlsBox!.width / 2 - (stageBox!.x + stageBox!.width / 2),
		),
	).toBeLessThanOrEqual(1);

	let toggle = (name: "Play diagram" | "Pause diagram") =>
		controls.getByRole("button", { name, exact: true });
	let previous = controls.getByRole("button", { name: "Previous step", exact: true });
	let next = controls.getByRole("button", { name: "Next step", exact: true });
	let restart = controls.getByRole("button", { name: "Restart diagram", exact: true });
	let shown = controls.locator(".ch-diagram__step");
	let total = Number(await first.locator("svg.sc-svg").getAttribute("data-sc-steps"));
	expect(total).toBeGreaterThan(3);
	let counter = (step: number) => controls.getByText(`${step} / ${total}`, { exact: true });
	let at = async () => Number((await shown.textContent())!.split(" / ")[0]);

	// Playing counts the step being played, and the arrows wait for a pause.
	await restart.click();
	await expect(counter(1)).toBeVisible();
	await expect(previous).toBeDisabled();
	await expect(next).toBeDisabled();
	await expect.poll(at, { intervals: [50] }).toBeGreaterThan(1);
	await toggle("Pause diagram").click();
	await expect(toggle("Play diagram")).toBeFocused();
	let paused = await at();
	expect(paused).toBeLessThan(total);
	await page.waitForTimeout(1000);
	await expect(counter(paused)).toBeVisible();

	await next.click();
	await expect(counter(paused + 1)).toBeVisible();
	for (let step = paused; step >= 1; step--) {
		await previous.click();
		await expect(counter(step)).toBeVisible();
	}
	// A disabled arrow keeps focus, so the keyboard never drops out of the bar.
	await expect(previous).toBeDisabled();
	await expect(previous).toBeFocused();

	// Play resumes from the step on screen and stops at the last one.
	await toggle("Play diagram").click();
	await expect(toggle("Pause diagram")).toBeVisible();
	await expect.poll(at, { intervals: [50] }).toBeGreaterThan(1);
	await expect(counter(total)).toBeVisible({ timeout: 10_000 });
	await expect(toggle("Play diagram")).toBeVisible();
	await expect(next).toBeDisabled();
	await expect(previous).toBeEnabled();

	await restart.click();
	await expect(counter(1)).toBeVisible();
	await expect(toggle("Pause diagram")).toBeVisible();
	await expect(controls.getByRole("button", { name: "Replay diagram" })).toHaveCount(0);
	await expect(controls.getByRole("button", { name: "Reset diagram" })).toHaveCount(0);
});

test("a wireframe fence is drawn chromeless, and an invalid one stays code", async ({ page }) => {
	let blocks = page.locator("[data-wireframe-document] .planCode");
	let drawn = blocks.first();
	let invalid = blocks.last();
	let region = drawn.getByRole("region", { name: "Implementation wireframe", exact: true });
	await expect(region).toBeVisible();
	await expect(region.getByText("Approve and build this plan", { exact: true })).toBeVisible();
	await expect(drawn.locator("[data-plan-source]")).toBeHidden();
	await expect(drawn.getByRole("button")).toHaveCount(0);

	await expect(invalid.getByRole("region")).toHaveCount(0);
	await expect(invalid.locator("[data-plan-source]")).toBeVisible();
	let error = invalid.locator("[data-plan-error]");
	await expect(error).toContainText("This wireframe could not be drawn");
	await expect(error).toContainText('Line 3: Unknown kind "buton".');
});

test("a narrow wireframe stacks its rows and puts notes below", async ({ page }) => {
	let narrow = page.locator('[data-wireframe-sample="narrow"]');
	let tasks = narrow.getByRole("region", { name: "Tasks wireframe", exact: true });
	await expect(tasks).toBeVisible();
	let done = await tasks.getByText("Parse fences", { exact: true }).boundingBox();
	let blocked = await tasks.getByText("Planner prompt", { exact: true }).boundingBox();
	let note = await tasks.getByText("Waits on server validation", { exact: true }).boundingBox();
	expect(blocked!.y).toBeGreaterThan(done!.y + done!.height);
	expect(Math.abs(blocked!.x - done!.x)).toBeLessThan(2);
	expect(note!.y).toBeGreaterThan(blocked!.y);
});

test("a wide wireframe keeps its flow across and its notes beside", async ({ page }) => {
	test.skip((page.viewportSize()?.width ?? 0) < 800, "Wide layout only");
	let tasks = page.locator('[data-wireframe-sample="tasks"]').getByRole("region");
	let done = await tasks.getByText("Parse fences", { exact: true }).boundingBox();
	let blocked = await tasks.getByText("Planner prompt", { exact: true }).boundingBox();
	let note = await tasks.getByText("Waits on server validation", { exact: true }).boundingBox();
	expect(Math.abs(blocked!.y - done!.y)).toBeLessThan(2);
	expect(blocked!.x).toBeGreaterThan(done!.x + done!.width);
	expect(note!.x).toBeGreaterThan(blocked!.x);
});
