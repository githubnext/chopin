import { expect, test } from "@playwright/test";

test("process text stays inside chevrons without overlapping at fitted and actual size", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/diagram-gallery");
	await page.getByRole("navigation", { name: "Diagram types" })
		.getByRole("button", { name: "Process", exact: true }).click();
	let preview = page.locator("[data-catalogue-preview]");
	// Match the document's prose measure even when the gallery has a wider preview lane.
	await preview.evaluate(element => element.style.maxWidth = "650px");
	await expect(preview.getByRole("button", { name: "1. Propose proactively", exact: true }))
		.toBeVisible();
	await page.evaluate(() => document.fonts.ready);

	for (let size of ["Fit to width", "Actual size"]) {
		await preview.getByRole("button", { name: size, exact: true }).click();
		let violations = await preview.locator("svg.sc-svg").evaluate(svg => {
			let problems: string[] = [];
			for (let node of svg.querySelectorAll<SVGGElement>("[data-sc-node]")) {
				let shape = node.querySelector<SVGGraphicsElement>(".n-box")!.getBBox();
				let lines = [...node.querySelectorAll<SVGTextElement>(".n-label, .n-sub")];
				for (let [index, line] of lines.entries()) {
					let box = line.getBBox();
					if (
						box.x < shape.x + 16 - 1 || box.x + box.width > shape.x + shape.width - 16 + 1
						|| box.y < shape.y || box.y + box.height > shape.y + shape.height
					) problems.push(`Outside chevron: ${line.textContent}`);
					let previous = lines[index - 1]?.getBBox();
					if (previous && box.y < previous.y + previous.height) {
						problems.push(`Overlapping lines: ${line.textContent}`);
					}
				}
			}
			return problems;
		});
		expect(violations).toEqual([]);
	}

	let first = preview.getByRole("button", { name: "1. Propose proactively", exact: true });
	await first.focus();
	await first.press("Enter");
	await expect(preview.getByRole("complementary", { name: "Diagram details" })).toBeVisible();
	let widths = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth,
	}));
	expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1);
});
