/** Global keyboard shortcuts, their hints, and the shortcuts sheet. */

import { content, expect, test } from "./room";
import { shortcutPlatform } from "../apps/web/src/shortcuts";

import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat" });
}

async function blur(page: Page) {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function pressShortcut(page: Page, code: string) {
	let browser = await page.evaluate(() => ({
		userAgent: navigator.userAgent,
		platform: navigator.platform,
	}));
	let platform = shortcutPlatform(browser.userAgent, browser.platform);
	await page.keyboard.press(`${platform === "mac" ? "Meta" : "Control"}+${code}`);
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
	await pressShortcut(page, "KeyK");
	await expect(search).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(search).toHaveCount(0);

	await content(page).click();
	await pressShortcut(page, "KeyK");
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

test("the link chord takes a keyboard selection the editor has not heard about yet", async ({ join }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("linked");
	// The selection change that tells the editor runs as its own task, so the next key can beat it.
	await content(page).evaluate(editor => {
		let selection = getSelection()!;
		for (let step = 0; step < "linked".length; step++) {
			selection.modify("extend", "backward", "character");
		}
		let mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
		editor.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				code: "KeyK",
				ctrlKey: !mac,
				key: "k",
				metaKey: mac,
			}),
		);
	});
	await expect(page.getByRole("textbox", { name: "Link URL" })).toBeFocused();
	await expect(page.getByRole("dialog", { name: "Search documents" })).toHaveCount(0);
});

test("the sidebar chord hides and shows Projects", async ({ join }) => {
	let page = await join("ana");
	await content(page).click();
	await pressShortcut(page, "Backslash");
	await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toHaveCount(0);
	await pressShortcut(page, "Backslash");
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
});

test("the chat chord toggles Chat without leaving the editor", async ({ join }) => {
	let page = await join("ana");
	await expect(chatPane(page)).toBeVisible();
	await content(page).click();
	await pressShortcut(page, "Period");
	await expect(chatPane(page)).toBeHidden();
	await expect(content(page)).toBeFocused();
	await pressShortcut(page, "Period");
	await expect(chatPane(page)).toBeVisible();
});

/** Counts width transitions that start on the sidebar and Chat tracks. */
async function recordPaneMotion(page: Page) {
	await page.evaluate(() => {
		let runs = { chat: 0, sidebar: 0 };
		(window as unknown as { paneRuns: typeof runs }).paneRuns = runs;
		document.addEventListener("transitionrun", event => {
			if (event.propertyName !== "width" || !(event.target instanceof Element)) return;
			if (event.target.matches(".motion-sidebar")) runs.sidebar++;
			if (event.target.matches(".workspace-chat-panel")) runs.chat++;
		});
	});
	return () =>
		page.evaluate(() =>
			(window as unknown as { paneRuns: { chat: number; sidebar: number } }).paneRuns
		);
}

test("the sidebar and Chat chords slide their panes as a click does", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await expect(chatPane(page)).toBeVisible();
	await content(page).click();
	let runs = await recordPaneMotion(page);

	await pressShortcut(page, "Backslash");
	await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
	await expect.poll(async () => (await runs()).sidebar).toBe(1);
	await pressShortcut(page, "Backslash");
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
	await expect.poll(async () => (await runs()).sidebar).toBe(2);

	await pressShortcut(page, "Period");
	await expect(chatPane(page)).toBeHidden();
	await expect.poll(async () => (await runs()).chat).toBe(1);
	await pressShortcut(page, "Period");
	await expect(chatPane(page)).toBeVisible();
	await expect.poll(async () => (await runs()).chat).toBe(2);
});

test("the sidebar and Chat chords settle at once under reduced motion", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await join("ana");
	await expect(chatPane(page)).toBeVisible();
	await content(page).click();
	let runs = await recordPaneMotion(page);

	await pressShortcut(page, "Backslash");
	await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
	await pressShortcut(page, "Backslash");
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
	await pressShortcut(page, "Period");
	await expect(chatPane(page)).toBeHidden();
	await pressShortcut(page, "Period");
	await expect(chatPane(page)).toBeVisible();
	expect(await runs()).toEqual({ chat: 0, sidebar: 0 });
});

test("Enter on Show sidebar moves focus to Hide sidebar", async ({ join, page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await page.getByRole("button", { name: "Hide sidebar" }).click();
	let show = page.getByRole("button", { name: "Show sidebar" });
	await show.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeFocused();
});

test("widening into the split layout settles Chat without sliding it in", async ({ join, page }) => {
	await page.setViewportSize({ width: 700, height: 900 });
	await join("ana");
	await expect(page.locator("[data-workspace-mode='compact']")).toHaveCount(1);
	let runs = await recordPaneMotion(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(chatPane(page)).toBeVisible();
	await page.waitForTimeout(400);
	expect((await runs()).chat).toBe(0);
});

test("Alt+N starts a new document only when nobody is typing", async ({ join }) => {
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
	await page.keyboard.press("Alt+KeyN");
	await expect(content(page)).toContainText("c");
	expect(created).toBe(0);
	await expect(dialog).toHaveCount(0);

	await blur(page);
	await page.keyboard.press("Alt+KeyN");
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
	await page.getByRole("button", { name: "Hide sidebar" }).click();
	await page.getByRole("button", { name: "Show sidebar" }).hover();
	await expect(tooltip).toHaveText("Show sidebar");
	await expect(tooltip).toHaveAttribute("data-shortcut", /^(⌘|Ctrl\+)\\$/);
});
