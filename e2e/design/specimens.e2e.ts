import { expect } from "@playwright/test";
import { specimens } from "./coverage";
import { capture, scan, test } from "./fixture";

for (let specimen of specimens) {
	test(`${specimen.id}: appearance and accessibility`, async ({ page }, info) => {
		let selector = "sample" in specimen
			? `[data-audit-item="${specimen.item}"] [data-audit-sample="${specimen.sample}"]`
			: `[data-audit-item="${specimen.id}"]`;
		let section = page.locator(selector);
		await section.scrollIntoViewIfNeeded();
		if (specimen.id === "code") {
			await expect(section.locator("diffs-container")).toHaveCount(2);
			await expect(section.locator("diffs-container").first().locator("pre")).toBeVisible();
		}
		// The seven-rung type plate is taller than a narrow viewport.
		if (specimen.id === "typography" && info.project.name === "narrow") {
			await capture(page, section.locator("header"), "typography-header.png");
			await capture(page, section.locator(".design-audit-type-stack"), "typography.png");
		} else {
			// Full plates contain their own spacing; only isolated button rows need ring padding.
			await capture(page, section, `${specimen.id}.png`, "sample" in specimen ? 6 : 0);
		}
		await scan(page, info, specimen.id, selector);
	});
}
