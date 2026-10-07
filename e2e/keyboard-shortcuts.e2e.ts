/** Global keyboard shortcuts, their hints, and the shortcuts sheet. */

import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat" });
}

async function blur(page: Page) {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test("? opens the keyboard shortcuts sheet outside text fields", async ({ join }) => {
	let page = await join("ana");
	await blur(page);
	await page.keyboard.press("Shift+Slash");
	let sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByText("Search documents")).toBeVisible();
	await expect(sheet.getByText("Show or hide chat")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);

	await content(page).click();
	await page.keyboard.type("?");
	await expect(sheet).toHaveCount(0);
	await expect(content(page)).toContainText("?");
});

test("the account menu opens the shortcuts sheet", async ({ join }) => {
	let page = await join("ana");
	await page.locator(".project-sidebar-account").click();
	await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
	await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("the search chord opens search, even from the editor", async ({ join }) => {
	let page = await join("ana");
	let search = page.getByRole("textbox", { name: "Search documents" });
	await blur(page);
	await page.keyboard.press("ControlOrMeta+KeyK");
	await expect(search).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(search).toHaveCount(0);

	await content(page).click();
	await page.keyboard.press("ControlOrMeta+KeyK");
	await expect(search).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(search).toHaveCount(0);

	// With text selected, the editor keeps the chord for its link editor.
	await content(page).click();
	await page.keyboard.type("linked");
	for (let step = 0; step < "linked".length; step++) await page.keyboard.press("Shift+ArrowLeft");
	await page.keyboard.press("ControlOrMeta+KeyK");
	await expect(page.getByRole("textbox", { name: "Link URL" })).toBeFocused();
	await expect(page.getByRole("dialog", { name: "Search documents" })).toHaveCount(0);
});

test("the sidebar chord hides and shows Projects", async ({ join }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.press("ControlOrMeta+Backslash");
	await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+Backslash");
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
});

test("the chat chord toggles Chat without leaving the editor", async ({ join }) => {
	let page = await join("ana");
	await expect(chatPane(page)).toBeVisible();
	await content(page).click();
	await page.keyboard.press("ControlOrMeta+Period");
	await expect(chatPane(page)).toBeHidden();
	await expect(content(page)).toBeFocused();
	await page.keyboard.press("ControlOrMeta+Period");
	await expect(chatPane(page)).toBeVisible();
});

test("C starts a new document only when nobody is typing", async ({ join }) => {
	let page = await join("ana");
	let created = 0;
	// Count creation without adding documents to repositories other tests share.
	await page.route(/\/api\/repositories\/[^/]+\/[^/]+\/channels$/, route => {
		if (route.request().method() !== "POST") return route.fallback();
		created++;
		return route.abort();
	});
	let dialog = page.getByRole("dialog", { name: "New document", exact: true });
	await content(page).click();
	await page.keyboard.type("c");
	await expect(content(page)).toContainText("c");
	expect(created).toBe(0);
	await expect(dialog).toHaveCount(0);

	await blur(page);
	await page.keyboard.press("c");
	await expect.poll(async () => created > 0 || await dialog.isVisible()).toBe(true);
});

test("icon tooltips show their shortcut", async ({ join }) => {
	let page = await join("ana");
	await page.getByRole("button", { name: "Hide sidebar" }).hover();
	let tooltip = page.locator("[data-icon-tooltip]");
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveText("Hide sidebar");
	await expect(tooltip).toHaveAttribute("data-shortcut", /^(⌘|Ctrl\+)\\$/);
	await page.getByRole("button", { name: "Add project" }).hover();
	await expect(tooltip).toHaveText("Add project");
	await expect(tooltip).toHaveAttribute("data-shortcut", "");
});
