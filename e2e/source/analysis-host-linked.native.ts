import { expect, test } from "@playwright/test";
import { analysis, load, message, prepareAnalysisHost } from "./analysis-host-native";

test.beforeAll(prepareAnalysisHost);

test(
	"linked sources remain keyboard navigable from diagnostics",
	async ({ page }) => {
		await page.setViewportSize({ width: 893, height: 850 });
		let errors = await load(page);
		await page.evaluate(() => window.analysisHostFixture.linked(true));
		let anchor = message(page, "host-review");
		await anchor.scrollIntoViewIfNeeded();
		let diagnosticsButton = anchor.getByRole("button", { name: /^Message details:/ });
		await diagnosticsButton.press("Enter");
		let panel = analysis(page, "host-review");
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("group", { name: "How excerpts were handled", exact: true }))
			.toBeVisible();
		let cardLinks = panel.locator("[data-card-link]");
		await expect(cardLinks).toHaveCount(3);
		await expect(cardLinks.nth(0)).toHaveText("Question");
		await expect(cardLinks.nth(1)).toHaveText("Option");
		await expect(cardLinks.nth(2)).toHaveText("Reason");
		await expect(panel.getByRole("button", { name: /^Constraint:/ })).toHaveCount(0);
		await expect(panel.getByRole("button", { name: "Add another excerpt", exact: true }))
			.toBeVisible();
		await page.keyboard.press("Escape");
		await diagnosticsButton.press("Enter");

		let proposal = panel.getByRole("button", { name: /^Option: show card for/ });
		await proposal.focus();
		await expect(proposal).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(panel).toHaveCount(0);
		expect(await page.evaluate(() => window.analysisHostFixture.cards)).toEqual(["host-thread"]);

		expect(errors).toEqual([]);
	},
);

test(
	"read-only diagnostics allow navigation but prevent correction and retries",
	async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		let errors = await load(page, "readonly");
		await page.evaluate(() => window.analysisHostFixture.linked(true));
		let anchor = message(page, "host-review");
		await anchor.scrollIntoViewIfNeeded();
		await anchor.getByRole("button", { name: /^Message details:/ }).press("Enter");
		let panel = analysis(page, "host-review");
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("group", { name: "How excerpts were handled", exact: true }))
			.toBeVisible();
		await expect(panel.getByRole("button", { name: "Add another excerpt", exact: true }))
			.toBeDisabled();
		await expect(panel.getByRole("button", { name: "Add excerpt", exact: true })).toHaveCount(0);
		await page.keyboard.press("Escape");

		let retry = message(page, "host-retry");
		await retry.getByRole("button", { name: /^Message details:/ }).press("Enter");
		await expect(
			analysis(page, "host-retry").getByRole("button", {
				name: "Retry analysis",
				exact: true,
			}),
		).toHaveCount(0);
		await page.keyboard.press("Escape");

		let jobs = message(page, "host-jobs");
		await jobs.getByRole("button", { name: /^Message details:/ }).press("Enter");
		await expect(
			analysis(page, "host-jobs").getByRole("button", {
				name: "Retry refine job",
				exact: true,
			}),
		).toHaveCount(0);
		await page.keyboard.press("Escape");

		await anchor.getByRole("button", { name: /^Message details:/ }).press("Enter");
		let linkedPanel = analysis(page, "host-review");
		let questionLink = linkedPanel.getByRole("button", { name: /^Question: show card for/ });
		await questionLink.focus();
		await expect(questionLink).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(linkedPanel).toHaveCount(0);
		expect(await page.evaluate(() => window.analysisHostFixture.cards)).toEqual(["host-thread"]);

		expect(errors).toEqual([]);
	},
);
