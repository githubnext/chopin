import { expect, test } from "@playwright/test";
import {
	analysis,
	inspect,
	load,
	openCorrection,
	prepareAnalysisHost,
} from "./analysis-host-native";
test.beforeAll(prepareAnalysisHost);

test("actual Transcript correction holds the exact versioned payload and rejected retry keeps its identity", async ({ page }) => {
	let errors = await load(page);
	let panel = await openCorrection(page);
	await panel.getByRole("combobox", { name: "Related option", exact: true }).selectOption(
		"host-option",
	);
	await page.evaluate(() => window.analysisHostFixture.hold("correction", true));
	await panel.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.corrections.length)).toBe(
		1,
	);
	let first = await page.evaluate(() => window.analysisHostFixture.corrections[0]!);
	expect(first).toEqual({
		actionId: expect.any(String),
		threadId: "host-thread",
		expectedVersion: 7,
		change: {
			kind: "add-excerpt",
			messageId: "host-review",
			start: 17,
			end: 27,
			contributionKind: "reason",
			targetOptionId: "host-option",
		},
	});
	await expect(panel.getByRole("button", { name: "Adding…", exact: true })).toBeDisabled();
	await expect(panel.getByRole("textbox", { name: "Exact text", exact: true })).toBeDisabled();
	await panel.getByRole("button", { name: "Adding…", exact: true }).evaluate((
		button: HTMLButtonElement,
	) => button.click());
	expect(await page.evaluate(() => window.analysisHostFixture.corrections.length)).toBe(1);
	await page.evaluate(() => {
		window.analysisHostFixture.hold("correction", false);
		window.analysisHostFixture.settle("correction", false);
	});
	await expect(panel.getByRole("alert")).toBeVisible();
	await panel.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.corrections.length)).toBe(
		2,
	);
	expect(await page.evaluate(() => window.analysisHostFixture.corrections[1])).toEqual(first);
	await expect(panel.getByRole("status")).toContainText(
		"Added to Where should we store data? as a reason.",
	);
	expect(errors).toEqual([]);
});

test("thread version refresh changes the next correction identity without silently using an old version", async ({ page }) => {
	let errors = await load(page);
	let panel = await openCorrection(page);
	await page.evaluate(() => window.analysisHostFixture.rejectNext("correction"));
	await panel.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect(panel.getByRole("alert")).toBeVisible();
	let first = await page.evaluate(() => window.analysisHostFixture.corrections[0]!);
	await page.evaluate(() => window.analysisHostFixture.version(8));
	await panel.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.corrections.length)).toBe(
		2,
	);
	let second = await page.evaluate(() => window.analysisHostFixture.corrections[1]!);
	expect(second.expectedVersion).toBe(8);
	expect(second.actionId).not.toBe(first.actionId);
	expect(second.change).toEqual(first.change);
	expect(errors).toEqual([]);
});

test("failed analysis retains one action ID until acknowledged and allocates a fresh next attempt", async ({ page }) => {
	let errors = await load(page);
	await inspect(page, "host-retry");
	let panel = analysis(page, "host-retry");
	await page.evaluate(() => window.analysisHostFixture.hold("analysis", true));
	await panel.getByRole("button", { name: "Retry analysis", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.analyses.length)).toBe(1);
	let first = await page.evaluate(() => window.analysisHostFixture.analyses[0]!);
	expect(first).toEqual({ messageId: "host-retry", actionId: expect.any(String) });
	await expect(panel.getByRole("button", { name: "Retry analysis", exact: true })).toBeDisabled();
	await page.evaluate(() => {
		window.analysisHostFixture.hold("analysis", false);
		window.analysisHostFixture.settle("analysis", false);
	});
	await expect(panel.getByRole("alert")).toContainText("Controlled held acknowledgement rejection");
	await panel.getByRole("button", { name: "Retry analysis", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.analyses.length)).toBe(2);
	expect(await page.evaluate(() => window.analysisHostFixture.analyses[1])).toEqual(first);
	await expect(panel.getByRole("button", { name: "Retry analysis", exact: true })).toBeEnabled();
	await panel.getByRole("button", { name: "Retry analysis", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.analyses.length)).toBe(3);
	expect(await page.evaluate(() => window.analysisHostFixture.analyses[2]!.actionId)).not.toBe(
		first.actionId,
	);
	expect(errors).toEqual([]);
});

test("failed job retries serialize both controls and recover after a rejected acknowledgement", async ({ page }) => {
	let errors = await load(page);
	await inspect(page, "host-jobs");
	let panel = analysis(page, "host-jobs");
	await expect(panel).toContainText("No changes published.");
	await page.evaluate(() => window.analysisHostFixture.hold("job", true));
	await panel.getByRole("button", { name: "Retry refine job", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.jobs.length)).toBe(1);
	await expect(panel.getByRole("button", { name: "Retrying refine job…", exact: true }))
		.toBeDisabled();
	await expect(panel.getByRole("button", { name: "Retry heading job", exact: true }))
		.toBeDisabled();
	await panel.getByRole("button", { name: "Retry heading job", exact: true }).evaluate((
		button: HTMLButtonElement,
	) => button.click());
	expect(await page.evaluate(() => window.analysisHostFixture.jobs)).toEqual(["host-job-0"]);
	await page.evaluate(() => {
		window.analysisHostFixture.hold("job", false);
		window.analysisHostFixture.settle("job", false);
	});
	await expect(panel.getByRole("alert")).toContainText("The Planner job could not be retried.");
	await panel.getByRole("button", { name: "Retry heading job", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.analysisHostFixture.jobs.length)).toBe(2);
	expect(await page.evaluate(() => window.analysisHostFixture.jobs)).toEqual([
		"host-job-0",
		"host-job-1",
	]);
	expect(errors).toEqual([]);
});
