import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
	analysis,
	load as loadAnalysis,
	message,
	prepareAnalysisHost,
} from "./analysis-host-native";
import { card, load as loadEvidence, panel, prepareEvidence } from "./evidence-hover-native";

const VIEWPORTS = [
	{ width: 390, height: 844 },
	{ width: 893, height: 850 },
	{ width: 1440, height: 900 },
];

test.describe("chat code button", () => {
	test.beforeAll(prepareAnalysisHost);

	test(
		"stays closed during reading and opens only on activation across viewport sizes",
		async ({ page }, testInfo) => {
			for (let viewport of VIEWPORTS) {
				await page.setViewportSize(viewport);
				await loadAnalysis(page);
				let anchor = message(page, "host-review");
				await anchor.scrollIntoViewIfNeeded();
				let trigger = anchor.getByRole("button", {
					name: "Analysis for message: unlinked",
					exact: true,
				});
				await anchor.hover();
				await trigger.focus();
				await anchor.locator("[data-chat-message-text]").click();
				await page.mouse.wheel(0, 100);
				await expect(analysis(page, "host-review")).toHaveCount(0);
				await anchor.scrollIntoViewIfNeeded();
				let [messageBounds, iconBounds] = await Promise.all([
					anchor.boundingBox(),
					trigger.boundingBox(),
				]);
				expect(messageBounds).toBeTruthy();
				expect(iconBounds).toBeTruthy();
				expect(iconBounds!.x + iconBounds!.width / 2).toBeGreaterThan(
					messageBounds!.x + messageBounds!.width / 2,
				);
				expect(iconBounds!.y).toBeGreaterThanOrEqual(messageBounds!.y);
				expect(iconBounds!.y).toBeLessThan(messageBounds!.y + 48);
				await trigger.click();
				await expect(analysis(page, "host-review")).toBeVisible();
				let box = await analysis(page, "host-review").boundingBox();
				expect(box).toBeTruthy();
				expect(box!.x).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
				if (viewport.width === 893) {
					await page.screenshot({ path: testInfo.outputPath("jev-005-chat-debug.png") });
				}
				await page.keyboard.press("Escape");
				await expect(analysis(page, "host-review")).toHaveCount(0);
				await expect(trigger).toBeFocused();
				await trigger.press("Space");
				await expect(analysis(page, "host-review")).toBeVisible();
				await analysis(page, "host-review").getByRole("button", {
					name: "Close analysis",
					exact: true,
				}).click();
				await expect(analysis(page, "host-review")).toHaveCount(0);
				await anchor.hover();
				await expect(analysis(page, "host-review")).toHaveCount(0);
				await trigger.press("Enter");
				await expect(analysis(page, "host-review")).toBeVisible();
				await page.locator("#host-outside").click();
				await expect(analysis(page, "host-review")).toHaveCount(0);
			}
		},
	);

	test("restoring diagnostics after a reset requires another explicit click", async ({ page }) => {
		await loadAnalysis(page);
		let anchor = message(page, "host-review");
		await anchor.scrollIntoViewIfNeeded();
		let trigger = anchor.getByRole("button", { name: /^Analysis for message:/ });
		await trigger.click();
		await expect(analysis(page, "host-review")).toBeVisible();
		await page.evaluate(() => window.analysisHostFixture.diagnostics(false));
		await expect(analysis(page, "host-review")).toHaveCount(0);
		await expect(trigger).toHaveCount(0);
		await page.evaluate(() => window.analysisHostFixture.diagnostics(true));
		await expect(trigger).toBeVisible();
		await expect(analysis(page, "host-review")).toHaveCount(0);
		await trigger.click();
		await expect(analysis(page, "host-review")).toBeVisible();
	});
});

test.describe("decision code button", () => {
	let stylesheet: string;
	test.beforeAll(async () => {
		await prepareEvidence();
		let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
		let style = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name));
		expect(style).toBeTruthy();
		stylesheet = await readFile(join(assets, style!), "utf8");
	});

	test(
		"sits left of source and keeps the portal keyboard reachable",
		async ({ page }, testInfo) => {
			for (let viewport of VIEWPORTS) {
				await page.setViewportSize(viewport);
				await loadEvidence(page);
				await page.addStyleTag({ content: stylesheet });
				let trigger = card(page).getByRole("button", {
					name: "Inspect decision evidence",
					exact: true,
				});
				let sourceButton = card(page).getByRole("button", {
					name: "Show source in chat",
					exact: true,
				});
				await card(page).hover();
				await trigger.focus();
				await expect(panel(page)).toHaveCount(0);
				let [iconBounds, sourceBounds] = await Promise.all([
					trigger.boundingBox(),
					sourceButton.boundingBox(),
				]);
				expect(iconBounds).toBeTruthy();
				expect(sourceBounds).toBeTruthy();
				expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(sourceBounds!.x);
				expect(sourceBounds!.x + sourceBounds!.width).toBeLessThanOrEqual(viewport.width);
				await trigger.press("Enter");
				await expect(panel(page)).toBeVisible();
				await expect.poll(() =>
					panel(page).evaluate(element => element.contains(document.activeElement))
				).toBe(true);
				await expect(panel(page).getByRole("button", { name: "Close evidence", exact: true }))
					.toBeFocused();
				await page.keyboard.press("Tab");
				await expect(
					panel(page).getByRole("button", {
						name: "Show “People already have GitHub accounts.” in chat",
						exact: true,
					}).first(),
				).toBeFocused();
				if (viewport.width === 893) {
					await page.screenshot({ path: testInfo.outputPath("jev-005-decision-debug.png") });
				}
				await page.keyboard.press("Escape");
				await expect(panel(page)).toHaveCount(0);
				await expect(trigger).toBeFocused();
				await card(page).hover();
				await expect(panel(page)).toHaveCount(0);
				await trigger.press("Space");
				await expect(panel(page)).toBeVisible();
				await panel(page).getByRole("button", { name: "Close evidence", exact: true }).click();
				await expect(trigger).toBeFocused();
				await sourceButton.click();
				expect(await page.evaluate(() => window.evidenceFixture.sources)).toContain("card-source");
			}
		},
	);
});
