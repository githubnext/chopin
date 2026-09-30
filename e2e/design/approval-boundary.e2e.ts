import { expect } from "@playwright/test";
import { scan, test } from "./fixture";

for (
	let scenario of [
		"new primary text",
		"changed code colour",
		"stale audit label",
		"other rule",
	] as const
) {
	test(`approval boundary: ${scenario}`, async ({ page }, info) => {
		let name = scenario === "changed code colour"
			? "code"
			: scenario === "stale audit label"
			? "badge"
			: "chat";
		let selector = `[data-audit-item="${name}"]`;
		await page.locator(selector).scrollIntoViewIfNeeded();
		await scan(page, info, name, selector);
		if (scenario === "changed code colour") {
			await page.locator(selector).locator('span[style="color:#D5901C"]').evaluate(node => {
				(node as HTMLElement).style.color = "#d6911c";
			});
		} else if (scenario === "stale audit label") {
			await page.locator(`${selector} .design-audit-source`).evaluate(node => {
				(node as HTMLElement).style.color = "#333333";
			});
		} else {
			await page.locator(selector).evaluate((node, missingName) => {
				let extra = document.createElement(missingName ? "button" : "p");
				if (!missingName) {
					extra.textContent = "Unapproved primary message";
					extra.style.cssText = "color: #bbbbbb; background: #ffffff";
				}
				node.append(extra);
			}, scenario === "other rule");
		}
		await expect(scan(page, info, name, selector)).rejects.toThrow(`Axe findings for ${name}`);
	});
}
