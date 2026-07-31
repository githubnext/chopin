/**
 * The two things that appear because of where the caret is.
 *
 * Both are placed by measurement against a live rectangle, so neither can be
 * covered by `bun test` — `bubble.test.ts` and `slash.test.ts` cover the
 * decisions those measurements feed, and stop at the point where a browser is
 * required. Everything here is on the other side of that line.
 */

import { content, expect, test, written } from "./room";

let MENU = { name: "Insert block" };
let BUBBLE = { name: "Text formatting" };

test("a slash at the start of a word offers blocks to insert", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/");

	let menu = page.getByRole("listbox", MENU);
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("option", { name: "Table" })).toBeVisible();
	await expect(menu.getByRole("option", { name: "Callout" })).toBeVisible();

	// Substring over label and keywords, so a query narrows rather than
	// resetting: "tab" keeps Table because "table" contains it.
	await page.keyboard.type("call");
	await expect(menu.getByRole("option")).toHaveCount(1);
	await expect(menu.getByRole("option")).toHaveText("Callout");
});

test("a slash inside a word is just a slash", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("and/or");

	// The menu opening on every path separator would make prose containing one
	// unwritable, which is most prose about software.
	await expect(page.getByRole("listbox", MENU)).toHaveCount(0);
});

test("escape closes the menu and leaves what was typed", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/tab");
	await expect(page.getByRole("listbox", MENU)).toBeVisible();

	await page.keyboard.press("Escape");

	await expect(page.getByRole("listbox", MENU)).toHaveCount(0);
	await expect(content(page)).toContainText("/tab");
});

test("choosing a table inserts one, with a header", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/table");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Table" }).click();

	await expect(content(page).locator("table")).toHaveCount(1);
	await expect(content(page).locator("th")).toHaveCount(3);
	await expect(content(page).locator("tr")).toHaveCount(3);

	// The query that summoned it has to go: leaving "/table" above the table
	// is the menu writing its own invocation into the document.
	await expect(content(page)).not.toContainText("/table");
});

test("a selection raises exactly one toolbar", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	// Two toolbars is the ported defect: one from the plugin list and one from
	// the surface, stacked, so the top one takes every click and the other is
	// only visible as a shadow slightly out of register.
	await expect(page.getByRole("toolbar", BUBBLE)).toHaveCount(1);
});

test("a mark from the toolbar reaches the file", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	let bubble = page.getByRole("toolbar", BUBBLE);
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await bubble.getByRole("button", { name: "Bold" }).click();
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await written(page, room, /^\*\*Pick a storage format\.\*\*$/m);
});

test("the block type menu converts the block it names", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("What we are building");
	await page.keyboard.press("Shift+Home");

	let bubble = page.getByRole("toolbar", BUBBLE);
	await bubble.getByRole("button", { name: "Block type: Text" }).click();

	// The submenu replaces the toolbar's contents rather than opening beside
	// it, so there is never a second popup to decide between.
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveCount(0);
	await bubble.getByRole("button", { name: "Heading 2" }).click();

	await expect(content(page).getByRole("heading", { level: 2 })).toHaveText(
		"What we are building",
	);
	await written(page, room, /^## What we are building$/m);
});

test("the link prompt refuses a scheme the dialect will not carry", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Read the docs.");
	await page.keyboard.press("Shift+Home");

	let said: string[] = [];
	page.on("dialog", async dialog => {
		said.push(dialog.message());
		await (dialog.type() === "prompt"
			? dialog.accept("javascript:alert(1)")
			: dialog.dismiss());
	});

	await page.getByRole("toolbar", BUBBLE).getByRole("button", { name: "Add link" }).click();

	/*
	 * Refused where the button is, not where the document is. A URL the
	 * dialect rejects applies locally, syncs, and is then refused by the
	 * server — which cannot undo a Yjs transaction, so it rebuilds the room
	 * under a fresh epoch and everybody in it loses their cursors.
	 */
	await expect.poll(() => said).toContain("Only https:, mailto:, relative paths are allowed here.");
	await expect(content(page).locator("a")).toHaveCount(0);

	await written(page, room, /^Read the docs\.$/m);
});
