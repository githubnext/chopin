import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/diagram-gallery");
	await expect(page.locator("[data-diagram-gallery]")).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
});

test("catalogue groups every fixture and renders representative families", async ({ page }) => {
	let types = page.getByRole("navigation", { name: "Diagram types" });
	await expect(types.getByRole("button")).toHaveCount(42);
	for (let family of ["Process", "Systems", "Structure", "Charts", "Data platform"]) {
		await expect(types.getByRole("heading", { name: family, exact: true })).toBeVisible();
	}
	for (let type of ["State", "Architecture", "Org chart", "Heatmap", "Medallion"]) {
		await types.getByRole("button", { name: type, exact: true }).click();
		await expect(page.locator("[data-catalogue-preview] .ch-diagram svg")).toBeVisible();
		await expect(page.locator("[data-catalogue-preview] .diagram-gallery-feature-heading h3"))
			.toHaveText(type);
	}
	await expect(page.locator("[data-featured-type] .ch-diagram svg")).toHaveCount(3);
});

test("document views use separate SVG resources and survive source changes", async ({ page }) => {
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

test("editable prose keeps caret, selection, typing, and undo after diagram focus", async ({ page }) => {
	let diagram = page.locator('[data-specimen-diagram="first"]');
	let node = diagram.locator("[data-sc-node]").first();
	await expect(node).toHaveAttribute("role", "button");
	await node.focus();
	await node.press("Enter");
	await diagram.getByRole("button", { name: "Next step" }).click();
	await expect(diagram.locator(".ch-diagram__status")).toContainText("Step 1 of");

	let prose = page.getByRole("textbox", { name: "Editable prose keyboard probe" });
	let original = (await prose.textContent()) ?? "";
	expect(original.length).toBeGreaterThan(2);
	await prose.focus();
	await prose.evaluate(element => {
		let text = element.firstChild;
		if (!text) throw new Error("Editable prose has no text node.");
		let range = document.createRange();
		range.setStart(text, 0);
		range.collapse(true);
		let selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	});
	await prose.press("ArrowRight");
	let caret = await prose.evaluate(element => {
		let selection = window.getSelection();
		return {
			inside: element.contains(selection?.anchorNode ?? null),
			offset: selection?.anchorOffset,
		};
	});
	expect(caret).toEqual({ inside: true, offset: 1 });
	await prose.press("Shift+ArrowRight");
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(original[1]);
	await prose.press("ArrowRight");
	await page.keyboard.type("x");
	let edited = `${original.slice(0, 2)}x${original.slice(2)}`;
	await expect.poll(() => prose.textContent()).toBe(edited);
	await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
	await expect.poll(() => prose.textContent()).toBe(original);
	await expect(diagram.locator(".ch-diagram__status")).toContainText("Step 1 of");
});

test("gallery fits the viewport with local Inter loaded", async ({ page }) => {
	let widths = await page.evaluate(() => {
		let gallery = document.querySelector<HTMLElement>("[data-diagram-gallery]");
		return {
			viewport: gallery?.clientWidth ?? 0,
			content: gallery?.scrollWidth ?? 0,
			font: document.fonts.check('16px "Inter Variable"'),
		};
	});
	expect(widths.font).toBe(true);
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
	let prose = page.getByRole("textbox", { name: "Editable prose keyboard probe" });
	await prose.focus();
	await prose.evaluate(element => {
		let text = element.firstChild;
		if (!text) throw new Error("Editable prose has no text node.");
		let range = document.createRange();
		range.setStart(text, 0);
		range.collapse(true);
		let selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	});
	await prose.press("ArrowRight");
	await expect.poll(() => prose.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
});

test("reduced motion leaves diagram content readable", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(page.locator('[data-specimen-diagram="first"] .ch-diagram svg')).toBeVisible();
	await expect(page.locator('[data-specimen-diagram="first"]'))
		.not.toContainText("Replay");
	let reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
	expect(reduced).toBe(true);
});
