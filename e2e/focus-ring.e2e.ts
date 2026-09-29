/** The focus ring is keyboard-only, except on text fields. */

import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

function outlineStyle(target: Locator) {
	return target.evaluate(element => getComputedStyle(element).outlineStyle);
}

function modality(page: Page) {
	return page.evaluate(() => document.documentElement.dataset.focusInput);
}

function handle(page: Page) {
	return page.getByRole("separator", { name: "Resize chat" });
}

test("a pointer press hides the focus ring on a control", async ({ join }) => {
	let page = await join("ana");
	await handle(page).click();
	await expect(handle(page)).toBeFocused();
	expect(await modality(page)).toBe("pointer");
	expect(await outlineStyle(handle(page))).toBe("none");
});

test("Tab shows the focus ring on the next control", async ({ join }) => {
	let page = await join("ana");
	await handle(page).click();
	await page.keyboard.press("Tab");
	expect(await modality(page)).toBe("keyboard");
	let next = page.locator(":focus");
	await expect(next).not.toHaveAttribute("aria-label", "Resize chat");
	expect(await outlineStyle(next)).toBe("solid");
});

test("a chord counts as keyboard navigation, a bare modifier does not", async ({ join }) => {
	let page = await join("ana");
	await handle(page).click();
	await page.keyboard.press("Shift");
	expect(await modality(page)).toBe("pointer");
	await page.keyboard.press("Alt+ArrowDown");
	expect(await modality(page)).toBe("keyboard");
});

test("a text field keeps its focus ring after a click", async ({ join }) => {
	let page = await join("ana");
	await page.getByRole("button", { exact: true, name: "Add Project" }).click();
	let field = page.getByPlaceholder("Search repositories");
	await field.click();
	await expect(field).toBeFocused();
	expect(await modality(page)).toBe("pointer");
	expect(await outlineStyle(field)).toBe("solid");
});
