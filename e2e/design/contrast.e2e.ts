import { expect } from "@playwright/test";
import { contrastWalk } from "./contrast";
import { plate, test } from "./fixture";

import type { Measured } from "./contrast";

/**
 * Every text and every control people need to see on the audit plates meets WCAG 2.2 AA, in light
 * and in dark: 4.5:1 for text and placeholders, 3:1 for large text, icons in controls, field and
 * checkbox edges, status dots and focus rings, against the colour actually behind them. Disabled
 * controls are exempt, as WCAG exempts them; nothing else is (DESIGN.md's Contrast Rule). Chopin is
 * light only, so dark is the system's dark preference with the `.dark` class assistant-ui's copies
 * read: it must not lower a ratio either.
 */
function failures(rows: Measured[]): string[] {
	return rows
		.filter(row => !row.exempt && row.fg !== "none" && row.ratio < row.threshold)
		.map(row =>
			`${row.where} ${row.role} "${row.text}": ${row.fg} on ${row.bg} is ${row.ratio}:1, under ${row.threshold}:1 (${row.path})`
		);
}

for (let mode of ["light", "dark"] as const) {
	test(`every text and control on the plates meets AA contrast, in ${mode}`, async ({ page }) => {
		test.setTimeout(240_000);
		if (mode === "dark") {
			await page.emulateMedia({ colorScheme: "dark" });
			await page.evaluate(() => document.documentElement.classList.add("dark"));
		}
		// Code is coloured in place, and a diff's preview drawn, once the highlighter loads.
		for (let id of ["code", "diff"]) await plate(page, id).scrollIntoViewIfNeeded();
		await expect.poll(() =>
			plate(page, "code").evaluate(element =>
				[...CSS.highlights].filter(([name, highlight]) =>
					name.startsWith("plan-code-")
					&& [...highlight].some(range => element.contains(range.startContainer))
				).length
			)
		).toBeGreaterThan(3);
		await expect(plate(page, "diff").locator("diffs-container pre").first()).toBeVisible();
		let rows = await contrastWalk(page, "body");
		expect(rows.filter(row => row.role === "text").length).toBeGreaterThan(1000);
		expect(rows.filter(row => row.role === "focus ring").length).toBeGreaterThan(300);
		expect(failures(rows)).toEqual([]);

		// Chat's emoji picker opens over the plate.
		await plate(page, "emoji").getByRole("button", { name: "Show the emoji picker" }).click();
		let picker = plate(page, "emoji").locator("[data-audit-picker]");
		await picker.scrollIntoViewIfNeeded();
		let opened = await contrastWalk(page, '[data-audit-item="emoji"]');
		expect(opened.length).toBeGreaterThan(50);
		expect(failures(opened)).toEqual([]);
	});
}
