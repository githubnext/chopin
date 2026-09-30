import { expect } from "@playwright/test";
import { capture, plate, scan, test } from "./fixture";

let actions = "Actions for Design system audit";

test("menu: keyboard, visible focus, Escape and reduced motion", async ({ page }, info) => {
	let trigger = plate(page, "interactive-document-actions").getByRole("button", { name: actions });
	await trigger.focus();
	await page.keyboard.press("ArrowDown");
	let menu = page.getByRole("menu", { name: actions, exact: true });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	let archive = menu.getByRole("menuitem", { name: "Archive", exact: true });
	await expect(archive).toBeFocused();
	await capture(page, menu, "menu-focus.png");
	await scan(page, info, "menu", '.document-actions-menu[role="menu"]');
	await expect.poll(() => menu.evaluate(element => element.getAnimations({ subtree: true }).length))
		.toBe(0);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test(
	"dialog: initial focus, trap, disabled save, error and focus return",
	async ({ page }, info) => {
		await plate(page, "interactive-document-actions").getByRole("checkbox", {
			name: "Simulate save error",
		}).check();
		let trigger = page.getByRole("button", { name: actions, exact: true });
		await trigger.focus();
		await page.keyboard.press("ArrowDown");
		await page.getByRole("menuitem", { name: "Rename", exact: true }).press("Enter");
		let dialog = page.getByRole("dialog", { name: "Rename document", exact: true });
		let title = dialog.getByRole("textbox", { name: "Document title", exact: true });
		await expect(title).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(title).toBeFocused();
		await title.fill("");
		await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await capture(page, dialog, "dialog-disabled.png", 0);
		await scan(page, info, "dialog-disabled", '.navigation-modal-content[role="dialog"]');
		await title.fill("Revised document title");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog.getByRole("alert")).toHaveText("Could not rename document.");
		await expect(title).toHaveAttribute("aria-invalid", "true");
		await capture(page, dialog, "dialog-error.png", 0);
		await scan(page, info, "dialog-error", '.navigation-modal-content[role="dialog"]');
		await expect.poll(() =>
			dialog.evaluate(element => element.getAnimations({ subtree: true }).length)
		)
			.toBe(0);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
	},
);

test("shared select: keyboard selection and focus return", async ({ page }, info) => {
	let trigger = plate(page, "fields").getByRole("combobox", { name: "Select", exact: true });
	await trigger.focus();
	await page.keyboard.press("ArrowDown");
	let list = page.locator('[data-slot="select-listbox"]');
	await expect(list).toBeVisible();
	await capture(page, list, "select-open.png");
	await scan(page, info, "select", '[data-slot="select-popup"]');
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await expect(trigger).toContainText("Archived documents");
	await expect(trigger).toBeFocused();
});

test("reduced motion also applies to pointer-opened overlays", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("button", { name: actions, exact: true }).click();
	let menu = page.getByRole("menu", { name: actions, exact: true });
	await expect(menu).toHaveAttribute("data-motion-immediate", "true");
	let menuMotion = await menu.evaluate(element => ({
		transition: getComputedStyle(element).transitionDuration,
		animation: getComputedStyle(element).animationDuration,
	}));
	for (let value of Object.values(menuMotion)) {
		expect(value.split(",").every(duration => parseFloat(duration) <= 0.001)).toBe(true);
	}
	await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
	let dialog = page.getByRole("dialog", { name: "Rename document", exact: true });
	let duration = await dialog.evaluate(element => getComputedStyle(element).transitionDuration);
	expect(duration.split(",").every(value => parseFloat(value) <= 0.001)).toBe(true);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
});
