import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { load as loadAnalysis, message, prepareAnalysisHost } from "./analysis-host-native";
import { card, load as loadEvidence, prepareEvidence } from "./evidence-hover-native";

const VIEWPORTS = [
	{ width: 390, height: 844 },
	{ width: 893, height: 850 },
];

test.describe("chat diagnostic controls", () => {
	test.beforeAll(prepareAnalysisHost);

	test("remain inside their message without covering its leading edge", async ({ page }) => {
		for (let viewport of VIEWPORTS) {
			await page.setViewportSize(viewport);
			await loadAnalysis(page);
			let anchor = message(page, "host-review");
			await anchor.scrollIntoViewIfNeeded();
			let trigger = anchor.getByRole("button", { name: /^Analysis for message:/ });
			await expect(trigger).toBeVisible();
			let [messageBounds, iconBounds] = await Promise.all([
				anchor.boundingBox(),
				trigger.boundingBox(),
			]);
			expect(messageBounds).toBeTruthy();
			expect(iconBounds).toBeTruthy();
			expect(iconBounds!.x).toBeGreaterThan(messageBounds!.x + messageBounds!.width / 2);
			expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(viewport.width);
			expect(iconBounds!.y).toBeGreaterThanOrEqual(messageBounds!.y);
			expect(iconBounds!.y + iconBounds!.height)
				.toBeLessThanOrEqual(messageBounds!.y + messageBounds!.height);
		}
	});
});

test.describe("decision diagnostic controls", () => {
	let stylesheet: string;
	test.beforeAll(async () => {
		await prepareEvidence();
		let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
		let style = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name));
		expect(style).toBeTruthy();
		stylesheet = await readFile(join(assets, style!), "utf8");
	});

	test("do not overlap source navigation or clip at narrow widths", async ({ page }) => {
		for (let viewport of VIEWPORTS) {
			await page.setViewportSize(viewport);
			await loadEvidence(page);
			await page.addStyleTag({ content: stylesheet });
			let trigger = card(page).getByRole("button", { name: /^Evidence:/ });
			let sourceButton = card(page).getByRole("button", {
				name: "Show source in chat",
				exact: true,
			});
			await expect(trigger).toBeVisible();
			await expect(sourceButton).toBeVisible();
			let [summaryBounds, sourceBounds] = await Promise.all([
				trigger.boundingBox(),
				sourceButton.boundingBox(),
			]);
			expect(summaryBounds).toBeTruthy();
			expect(sourceBounds).toBeTruthy();
			expect(summaryBounds!.x).toBeGreaterThanOrEqual(0);
			expect(summaryBounds!.x + summaryBounds!.width).toBeLessThanOrEqual(viewport.width);
			// The summary sits under the options, clear of the header's source control.
			expect(summaryBounds!.y).toBeGreaterThanOrEqual(sourceBounds!.y + sourceBounds!.height);
			expect(sourceBounds!.x + sourceBounds!.width).toBeLessThanOrEqual(viewport.width);
		}
	});
});
