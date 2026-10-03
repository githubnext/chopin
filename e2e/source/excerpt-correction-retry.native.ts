import { expect, test } from "@playwright/test";

import { openForm, prepareForm } from "./excerpt-correction-native";

test.beforeAll(prepareForm);

test("real callback keeps retry identity and exact source/version fields", async ({ page }) => {
	await openForm(page);
	await page.getByRole("textbox", { name: "Exact text", exact: true }).fill("encryption");
	await page.getByRole("combobox", { name: "Related option", exact: true }).selectOption(
		"option-1",
	);
	await page.evaluate(() => {
		window.analysisFixture.fail = true;
	});
	await page.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not add this excerpt. Check the card and connection, then try again.",
	);
	let first = await page.evaluate(() => window.analysisFixture.calls[0]!);
	expect(first).toMatchObject({
		threadId: "thread-1",
		expectedVersion: 7,
		change: {
			kind: "add-excerpt",
			messageId: "message-1",
			start: 17,
			end: 27,
			contributionKind: "reason",
			targetOptionId: "option-1",
		},
	});
	expect(first.actionId).toMatch(/^[0-9a-f-]{36}$/);
	await page.evaluate(() => {
		window.analysisFixture.fail = true;
	});
	await page.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect.poll(async () => page.evaluate(() => window.analysisFixture.calls.length)).toBe(2);
	let second = await page.evaluate(() => window.analysisFixture.calls[1]!);
	expect(second).toEqual(first);
	await page.getByRole("textbox", { name: "Exact text", exact: true }).fill("needs encryption");
	await page.getByRole("button", { name: "Add excerpt", exact: true }).click();
	await expect.poll(async () => page.evaluate(() => window.analysisFixture.calls.length)).toBe(3);
	expect(await page.evaluate(() => window.analysisFixture.calls[2]!.actionId)).not.toBe(
		first.actionId,
	);
});

test("ambiguous and empty sources block submission and option clears related target", async ({ page }) => {
	await openForm(page);
	let exact = page.getByRole("textbox", { name: "Exact text", exact: true });
	await exact.fill("S3");
	await expect(page.getByRole("button", { name: "Add excerpt", exact: true })).toBeDisabled();
	await exact.fill("");
	await expect(page.getByRole("button", { name: "Add excerpt", exact: true })).toBeDisabled();
	await exact.fill("not in the saved excerpt");
	await expect(page.getByRole("button", { name: "Add excerpt", exact: true })).toBeDisabled();
	await exact.fill("encryption");
	await page.getByRole("combobox", { name: "Related option", exact: true }).selectOption(
		"option-1",
	);
	await page.getByRole("combobox", { name: "Contribution type", exact: true }).selectOption(
		"option",
	);
	await expect(page.getByRole("combobox", { name: "Related option", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Add excerpt", exact: true }).click();
	let call = await page.evaluate(() => window.analysisFixture.calls[0]!);
	expect(call.change.contributionKind).toBe("option");
	expect(call.change).not.toHaveProperty("targetOptionId");
});
