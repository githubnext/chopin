import { expect, test } from "@playwright/test";

import { loadForm, openForm, prepareForm } from "./excerpt-correction-native";

test.beforeAll(prepareForm);

test("actual form focuses contribution type and excludes inactive cards", async ({ page }) => {
	await loadForm(page);
	await page.getByRole("button", { name: "Add to card", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "Contribution type", exact: true }))
		.toBeFocused();
	let cards = page.getByRole("combobox", { name: "Decision card", exact: true });
	expect(
		await cards.locator("option").evaluateAll(options =>
			options.map(option => (option as HTMLOptionElement).value)
		),
	).toEqual(["", "thread-1"]);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "Contribution type", exact: true })).toHaveCount(
		0,
	);
	await page.getByRole("button", { name: "Add to card", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "Contribution type", exact: true }))
		.toBeFocused();
});

test("held callback disables every input and prevents duplicate submission", async ({ page }) => {
	await openForm(page);
	await page.evaluate(() => {
		window.analysisFixture.hold = true;
	});
	await page.getByRole("button", { name: "Add excerpt", exact: true }).click();
	let submitting = page.getByRole("button", { name: "Adding…", exact: true });
	await expect(submitting).toBeDisabled();
	await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
	for (let name of ["Contribution type", "Decision card", "Related option"]) {
		await expect(page.getByRole("combobox", { name, exact: true })).toBeDisabled();
	}
	await expect(page.getByRole("textbox", { name: "Exact text", exact: true })).toBeDisabled();
	await submitting.evaluate((button: HTMLButtonElement) => button.click());
	expect(await page.evaluate(() => window.analysisFixture.calls.length)).toBe(1);
	await page.evaluate(() => window.analysisFixture.release());
	await expect(page.getByRole("status")).toHaveText(
		"Added to Where should we store data? as a reason.",
	);
	await expect(page.getByRole("button", { name: "Add another excerpt", exact: true }))
		.toBeVisible();
});

test("read-only, missing callback and inactive state refuse native clicks", async ({ page }) => {
	await loadForm(page, "readonly");
	for (let mode of ["readonly", "missing-callback", "inactive"] as const) {
		await page.evaluate(mode => window.analysisFixture.mount(mode), mode);
		let trigger = page.getByRole("button", { name: "Add to card", exact: true });
		await expect(trigger).toBeDisabled();
		await trigger.evaluate((button: HTMLButtonElement) => button.click());
		expect(await page.evaluate(() => window.analysisFixture.calls)).toEqual([]);
	}
	await page.evaluate(() => window.analysisFixture.mount("editable"));
	await page.getByRole("button", { name: "Add to card", exact: true }).click();
	await page.getByRole("combobox", { name: "Decision card", exact: true }).selectOption("thread-1");
	await page.evaluate(() => window.analysisFixture.setEditable(false));
	await expect(page.getByRole("button", { name: "Add excerpt", exact: true })).toBeDisabled();
});
