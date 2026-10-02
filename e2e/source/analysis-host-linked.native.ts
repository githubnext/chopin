import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { analysis, load, message, prepareAnalysisHost } from "./analysis-host-native";

test.beforeAll(prepareAnalysisHost);

async function capture(page: Page, testInfo: TestInfo, name: string) {
	await page.addStyleTag({
		content: `
			#host-outside { display: none; }
			.analysis-host-chat { height: calc(100vh - 48px); }
			.analysis-host-chat [data-chat-message-id^="host-background-"] { display: none; }
		`,
	});
	await page.evaluate(() => {
		let scroller = document.querySelector<HTMLElement>(
			".analysis-host-chat > [data-focus-boundary]",
		)!;
		let target = document.querySelector<HTMLElement>(
			'[data-chat-message-id="host-review"]',
		)!;
		scroller.scrollTop += target.getBoundingClientRect().top
			- scroller.getBoundingClientRect().top - 16;
		(document.activeElement as HTMLElement | null)?.blur();
	});
	await page.screenshot({ path: testInfo.outputPath(name) });
}

test(
	"linked sources stay out of the transcript and remain keyboard navigable",
	async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 893, height: 850 });
		let errors = await load(page);
		await page.evaluate(() => window.analysisHostFixture.linked(true));
		let anchor = message(page, "host-review");
		await anchor.scrollIntoViewIfNeeded();
		let diagnosticsButton = anchor.getByRole("button", { name: /^Analysis for message:/ });
		await diagnosticsButton.press("Enter");
		let panel = analysis(page, "host-review");
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("group", { name: "Linked decisions", exact: true }))
			.toBeVisible();
		let cardLinks = panel.locator("[data-card-link]");
		await expect(cardLinks).toHaveCount(3);
		await expect(cardLinks.nth(0)).toHaveText("Question");
		await expect(cardLinks.nth(1)).toHaveText("Proposal");
		await expect(cardLinks.nth(2)).toHaveText("Reason");
		await expect(panel.getByRole("button", { name: /^Constraint:/ })).toHaveCount(0);
		await expect(panel.getByRole("button", { name: "Add another excerpt", exact: true }))
			.toBeVisible();
		await page.keyboard.press("Escape");
		await expect(anchor.getByRole("button", { name: "Review 1 excerpt", exact: true }))
			.toHaveCount(0);
		await expect(anchor.locator("[data-card-link]")).toHaveCount(0);
		await diagnosticsButton.press("Enter");

		let proposal = panel.getByRole("button", { name: /^Proposal: show card for/ });
		await proposal.focus();
		await expect(proposal).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(panel).toHaveCount(0);
		expect(await page.evaluate(() => window.analysisHostFixture.cards)).toEqual(["host-thread"]);

		await anchor.scrollIntoViewIfNeeded();
		await capture(page, testInfo, "transcript-desktop-893x850.png");
		expect(errors).toEqual([]);
	},
);

test(
	"compact transcript stays clean and read-only diagnostics cannot correct or retry",
	async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 390, height: 844 });
		let errors = await load(page, "readonly");
		await page.evaluate(() => window.analysisHostFixture.linked(true));
		let anchor = message(page, "host-review");
		await anchor.scrollIntoViewIfNeeded();
		await anchor.getByRole("button", { name: /^Analysis for message:/ }).press("Enter");
		let panel = analysis(page, "host-review");
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("group", { name: "Linked decisions", exact: true }))
			.toBeVisible();
		await expect(panel.getByRole("button", { name: "Add another excerpt", exact: true }))
			.toBeDisabled();
		await expect(panel.getByRole("button", { name: "Add excerpt", exact: true })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(anchor.getByRole("button", { name: "Review 1 excerpt", exact: true }))
			.toHaveCount(0);
		await expect(anchor.locator("[data-card-link]")).toHaveCount(0);

		let retry = message(page, "host-retry");
		await retry.getByRole("button", { name: /^Analysis for message:/ }).press("Enter");
		await expect(
			analysis(page, "host-retry").getByRole("button", {
				name: "Retry analysis",
				exact: true,
			}),
		).toHaveCount(0);
		await page.keyboard.press("Escape");

		let jobs = message(page, "host-jobs");
		await jobs.getByRole("button", { name: /^Analysis for message:/ }).press("Enter");
		await expect(
			analysis(page, "host-jobs").getByRole("button", {
				name: "Retry refine job",
				exact: true,
			}),
		).toHaveCount(0);
		await page.keyboard.press("Escape");

		await anchor.getByRole("button", { name: /^Analysis for message:/ }).press("Enter");
		let linkedPanel = analysis(page, "host-review");
		let questionLink = linkedPanel.getByRole("button", { name: /^Question: show card for/ });
		await questionLink.focus();
		await expect(questionLink).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(linkedPanel).toHaveCount(0);
		expect(await page.evaluate(() => window.analysisHostFixture.cards)).toEqual(["host-thread"]);

		await anchor.scrollIntoViewIfNeeded();
		await capture(page, testInfo, "transcript-compact-390x844.png");
		expect(errors).toEqual([]);
	},
);
