/** The focus ring is keyboard-only, except on text fields. */

import { expect, test } from "./room";

async function outlineStyle(target: import("@playwright/test").Locator) {
	return target.evaluate(element => getComputedStyle(element).outlineStyle);
}

test("a pointer press hides the focus ring on a button", async ({ join }) => {
	let page = await join("ana");
	let button = page.getByRole("button", { exact: true, name: "Add Project" });
	await button.click();
	await expect(button).toBeFocused();
	expect(await outlineStyle(button)).toBe("none");
});

test("Tab shows the focus ring on a button", async ({ join }) => {
	let page = await join("ana");
	let button = page.getByRole("button", { exact: true, name: "Add Project" });
	await button.click();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(button).toBeFocused();
	expect(await outlineStyle(button)).toBe("solid");
});

test("a text field keeps its focus ring after a click", async ({ join }) => {
	let page = await join("ana");
	await page.getByRole("button", { exact: true, name: "Add Project" }).click();
	let field = page.getByPlaceholder("Search repositories");
	await field.click();
	await expect(field).toBeFocused();
	expect(await outlineStyle(field)).toBe("solid");
});
