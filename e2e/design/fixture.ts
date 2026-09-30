import { expect, test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { approvedContrast } from "./approved-contrast";

import type { Locator, Page, TestInfo } from "@playwright/test";

export let test = base.extend({
	page: async ({ page }, use) => {
		// All authored content is fixed. Network images are deterministic local SVG fixtures;
		// the deliberately unavailable image remains a failed request.
		await page.route(
			/https:\/\/(avatars\.githubusercontent\.com\/|github\.com\/.*\.png)/,
			route =>
				route.fulfill({
					contentType: "image/svg+xml",
					body:
						'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#e6ece8"/><circle cx="40" cy="31" r="13" fill="#66776d"/><path d="M17 73c0-27 46-27 46 0" fill="#66776d"/></svg>',
				}),
		);
		await page.route("https://invalid.example.invalid/**", route => route.abort());
		await page.goto("/design-audit");
		await expect(page.getByRole("heading", { name: "Chopin design audit", exact: true }))
			.toBeVisible();
		// Late diagram/math/code rendering above the last plate changes its scroll position.
		// Wait for those real renderers, not an arbitrary delay or a clipped screenshot.
		await expect(page.locator('[data-audit-item="diagram"] .plan-diagram svg')).toBeVisible();
		await expect(page.locator('[data-audit-item="diagram"] [data-plan-error]')).toBeVisible();
		await expect(page.locator('[data-audit-item="formula"] .katex')).toHaveCount(2);
		await expect(page.locator('[data-audit-item="code"] diffs-container pre')).toHaveCount(2);
		// The catalogue's later image plate uses native lazy loading. Load its fixed fixtures
		// now so scrolling to the table does not replace placeholders underneath capture.
		await page.locator("img[loading=lazy]").evaluateAll(images => {
			for (let image of images) (image as HTMLImageElement).loading = "eager";
		});
		await expect.poll(() =>
			page.evaluate(() => [...document.images].every(image => image.complete))
		)
			.toBe(true);
		await page.evaluate(async () => {
			await document.fonts.ready;
			await document.fonts.load('400 16px "Inter Variable"');
			await document.fonts.load('600 16px "Inter Variable"');
		});
		await expect.poll(() => page.evaluate(() => document.fonts.check('400 16px "Inter Variable"')))
			.toBe(true);
		await use(page);
	},
});

export function plate(page: Page, id: string) {
	return page.locator(`[data-audit-item="${id}"]`);
}

export async function scan(page: Page, info: TestInfo, name: string, selector: string) {
	let result = await new AxeBuilder({ page }).include(selector).analyze();
	let approved = approvedContrast(name, info.project.name);
	if (approved.length) {
		await info.attach("approved-colour-decision", {
			body:
				"Maggie retained the original Delete red, named supplementary chat/audit text and original code palette. Each accepted node is annotated with its approved role in approved-contrast/. Other findings still fail; see apps/web/DESIGN.md.",
			contentType: "text/plain",
		});
	}
	await info.attach(`axe-${name}`, {
		body: JSON.stringify(result, null, 2),
		contentType: "application/json",
	});
	await info.attach(`axe-${name}-summary`, {
		body: result.violations.map(violation =>
			`${violation.id}: ${violation.help}\n${
				violation.nodes.map(node => `${JSON.stringify(node.target)}\n${node.failureSummary}`).join(
					"\n\n",
				)
			}`
		).join("\n\n")
			|| `No automatic violations. ${result.incomplete.length} checks need manual review.`,
		contentType: "text/plain",
	});
	let failures = result.violations.flatMap(violation =>
		violation.nodes.map(node => ({
			rule: violation.id,
			target: node.target,
			html: node.html,
			evidence: node.failureSummary,
		}))
	);
	expect(failures, `Axe findings for ${name}; see attached JSON and summary`).toEqual(approved);
}

export async function capture(page: Page, target: Locator, name: string, padding = 6) {
	await target.evaluate(element =>
		element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
	);
	let box = await target.boundingBox();
	let viewport = page.viewportSize();
	if (!box || !viewport) throw new Error(`Missing capture bounds: ${name}`);
	// A tall locator inside the audit scroll container silently clips its own screenshot.
	// Keep every specimen within the viewport, with room for focus rings and shadows.
	expect(box.height, `Split ${name} into smaller specimens`).toBeLessThan(viewport.height - 16);
	expect(box.y, `${name} top must be visible`).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height, `${name} bottom must be visible`).toBeLessThanOrEqual(viewport.height);
	expect(box.x, `${name} left edge must be visible`).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width, `${name} right edge must be visible`).toBeLessThanOrEqual(
		viewport.width,
	);
	let x = Math.max(0, Math.floor(box.x - padding));
	let y = Math.max(0, Math.floor(box.y - padding));
	let width = Math.min(viewport.width - x, Math.ceil(box.width + padding * 2));
	let height = Math.min(viewport.height - y, Math.ceil(box.height + padding * 2));
	await expect(page).toHaveScreenshot(name, { clip: { x, y, width, height } });
}
