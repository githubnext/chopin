import { expect } from "@playwright/test";
import { specimens } from "./coverage";
import { capture, drawTheme, scan, test } from "./fixture";

// Each plate by day, and by night as System draws it when the system turns dark (`-dark` images).
for (let theme of ["light", "dark"] as const) {
	let suffix = theme === "dark" ? "-dark" : "";
	for (let specimen of specimens) {
		test(`${specimen.id}${suffix}: appearance and accessibility`, async ({ page }, info) => {
			await drawTheme(page, theme);
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
				await capture(page, section.locator("header"), `typography-header${suffix}.png`);
				await capture(page, section.locator(".design-audit-type-stack"), `typography${suffix}.png`);
			} else {
				// Full plates contain their own spacing; only isolated button rows need ring padding.
				await capture(page, section, `${specimen.id}${suffix}.png`, "sample" in specimen ? 6 : 0);
			}
			await scan(page, info, `${specimen.id}${suffix}`, selector);
		});
	}
}
