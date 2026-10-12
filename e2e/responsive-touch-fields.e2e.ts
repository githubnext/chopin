/**
 * iOS zooms the page into a focused text field set below 16px. On touch, every field a person
 * can type into resolves to 16px or more, wherever it is styled: the document, Chat, Decisions,
 * renaming, commenting and search, on a phone and on a touch tablet. Desktop keeps its sizes.
 */

import { chatInput } from "./chat-input";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const TABLET = { hasTouch: true, isMobile: true, viewport: { width: 1194, height: 834 } };
const SOURCE = `# Field notes

Members lose edits when the train goes into a tunnel.

Second paragraph for a comment.
`;

/** Every visible field that would zoom on focus, by what it is and the size it resolves to. */
async function smallFields(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		let fields = document.querySelectorAll<HTMLElement>(
			"textarea, select, input:not([type=checkbox], [type=radio], [type=range], [type=color],"
				+ " [type=file], [type=hidden]), [contenteditable]:not([contenteditable=false])",
		);
		return [...fields]
			// A nested editor is focused through its outermost editable root.
			.filter(field =>
				!field.parentElement?.closest("[contenteditable]:not([contenteditable=false])")
			)
			.filter(field => {
				let box = field.getBoundingClientRect();
				return box.width > 0 && box.height > 0 && getComputedStyle(field).visibility !== "hidden";
			})
			.map(field => ({ field, size: parseFloat(getComputedStyle(field).fontSize) }))
			.filter(({ size }) => size < 16)
			.map(({ field, size }) =>
				`${field.tagName.toLowerCase()} ${
					field.getAttribute("aria-label") ?? field.getAttribute("placeholder") ?? field.className
				}: ${size}px`
			);
	});
}

async function selectPassage(page: Page) {
	await content(page).first().locator("p").filter({ hasText: "Second paragraph" }).selectText();
}

test("phone: every text field is at least 16px", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", PHONE);
	let tabs = page.getByRole("navigation", { name: "Workspace view" });

	await page.getByRole("button", { name: "Edit document" }).tap();
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	expect(await smallFields(page)).toEqual([]);
	await page.getByRole("button", { name: "Done editing" }).tap();

	await selectPassage(page);
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await expect(draft.getByPlaceholder("Add a comment")).toBeVisible();
	expect(await smallFields(page)).toEqual([]);
	await page.keyboard.press("Escape");
	await expect(draft).toHaveCount(0);

	await tabs.getByRole("button", { name: /^Chat/ }).tap();
	await expect(chatInput(page)).toBeVisible();
	expect(await smallFields(page)).toEqual([]);

	await tabs.getByRole("button", { name: /^Decisions/ }).tap();
	let decisions = page.locator('[data-document-view="decisions"]');
	await decisions.getByRole("button", { name: "Add an option" }).first().tap();
	await expect(decisions.locator(".question-field").first()).toBeVisible();
	expect(await smallFields(page)).toEqual([]);

	await tabs.getByRole("button", { name: "Document", exact: true }).tap();
	await page.locator(".phone-top-bar").getByRole("button", { name: /^Actions for / }).click();
	await page.getByRole("dialog", { name: /^Actions for / })
		.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
	expect(await smallFields(page)).toEqual([]);
	await page.keyboard.press("Escape");

	await page.locator(".phone-top-bar").getByRole("button", { name: "Documents", exact: true })
		.click();
	await expect(page.getByRole("searchbox", { name: "Search documents" })).toBeVisible();
	expect(await smallFields(page)).toEqual([]);
});

test("touch tablet: every text field is at least 16px", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", TABLET);
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	expect(await smallFields(page)).toEqual([]);

	await selectPassage(page);
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await expect(draft.getByPlaceholder("Add a comment")).toBeVisible();
	expect(await smallFields(page)).toEqual([]);
	await page.keyboard.press("Escape");
	await expect(draft).toHaveCount(0);

	let views = page.getByRole("group", { name: "Document view" });
	await views.getByRole("button", { name: /^Decisions/ }).click();
	let decisions = page.locator('[data-document-view="decisions"]');
	await decisions.getByRole("button", { name: "Add an option" }).first().click();
	await expect(decisions.locator(".question-field").first()).toBeVisible();
	expect(await smallFields(page)).toEqual([]);
	await views.getByRole("button", { name: "Document", exact: true }).click();

	// The desktop header's inline rename, which is smaller type than a field may be on touch.
	await page.getByRole("group", { name: /^Document: / }).getByRole("button", {
		name: /^Actions for /,
	}).click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	let title = page.getByRole("textbox", { name: "Document title" });
	await expect(title).toBeFocused();
	expect(await smallFields(page)).toEqual([]);
	await title.press("Escape");

	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByRole("textbox", { name: "Search documents" })).toBeFocused();
	expect(await smallFields(page)).toEqual([]);
});

test("desktop keeps the header rename at its own small size", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await page.getByRole("group", { name: /^Document: / }).getByRole("button", {
		name: /^Actions for /,
	}).click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	let title = page.getByRole("textbox", { name: "Document title" });
	await expect(title).toBeFocused();
	expect(await title.evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
		.toBeLessThan(16);
});
