import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

import type { Locator, Page } from "@playwright/test";

/**
 * The cursor says what a thing does (DESIGN.md, Cursors), on the design audit's own plates: the
 * pointer on everything a click acts on, Chopin's own controls and the copied assistant-ui and
 * shadcn elements alike; the zoom on a picture that opens the viewer; the arrow on a disabled
 * control; the browser's text cursor in editable text. Each is read where the mouse really is, from
 * the element the browser finds under it, so a layer left on top would fail here too.
 */
async function cursorOver(page: Page, target: Locator): Promise<string> {
	await target.scrollIntoViewIfNeeded();
	let box = (await target.boundingBox())!;
	let x = box.x + box.width / 2;
	let y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	let hit = await target.evaluate((element, [x, y]) => {
		let under = document.elementFromPoint(x!, y!);
		return {
			cursor: under ? getComputedStyle(under).cursor : "",
			inside: !!under && (element === under || element.contains(under)),
			under: under ? `${under.tagName.toLowerCase()}.${under.className}` : "nothing",
		};
	}, [x, y]);
	expect(hit.inside, `the pointer finds ${hit.under}, not the control`).toBe(true);
	return hit.cursor;
}

test("everything a click acts on shows the pointer, the copies included", async ({ page }) => {
	let assistant = plate(page, "assistant-ui");
	let controls: [string, Locator][] = [
		["a button", plate(page, "buttons").locator("button.btn:not(:disabled)").first()],
		[
			"the message toolbar",
			assistant.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
				name: "Add reaction",
			}),
		],
		["a reaction pill", assistant.locator("[data-audit-reactions] button").first()],
		["a menu item", plate(page, "menus").getByRole("menuitem", { name: "Rename document" })],
		["a tab", plate(page, "tabs").getByRole("tab", { name: "macOS" })],
		[
			"the composer's toolbar",
			plate(page, "chat").getByRole("button", { name: "Bold", exact: true }).first(),
		],
		["the send button", plate(page, "chat").getByRole("button", { name: "Send message" }).last()],
		["a link", plate(page, "links").getByRole("link").first()],
		["assistant-ui's model pill", assistant.getByRole("combobox", { name: /^Model/ }).first()],
		["assistant-ui's mention row", assistant.getByRole("button", { name: /Chopin\s*agent/ })],
		["a staged file's remove", assistant.getByRole("button", { name: "Remove notes.md" })],
	];
	for (let [name, control] of controls) {
		await expect(control, name).toBeEnabled();
		expect(await cursorOver(page, control), name).toBe("pointer");
	}
});

test("shadcn's menu and command rows and the emoji picker's tabs and cells show the pointer once open", async ({ page }) => {
	let assistant = plate(page, "assistant-ui");
	await assistant.getByRole("button", { name: "More actions" }).click();
	let item = page.locator('[data-slot="dropdown-menu-item"]').first();
	await expect(item).toBeVisible();
	expect(await cursorOver(page, item), "a copied menu row").toBe("pointer");
	await page.keyboard.press("Escape");
	await expect(item).toBeHidden();

	await assistant.getByRole("combobox", { name: /^Model/ }).first().click();
	let model = page.locator('[data-slot="model-selector-item"]').first();
	await expect(model).toBeVisible();
	expect(await cursorOver(page, model), "a model in the selector").toBe("pointer");
	await page.keyboard.press("Escape");
	await expect(model).toBeHidden();

	let show = plate(page, "emoji").getByRole("button", { name: "Show the emoji picker" });
	await show.scrollIntoViewIfNeeded();
	await show.click();
	let picker = plate(page, "emoji").locator("[data-audit-picker]");
	await expect(picker.locator("[data-emoji]").nth(100)).toBeAttached();
	expect(await cursorOver(page, picker.getByRole("tab").nth(1)), "a picker tab").toBe("pointer");
	expect(await cursorOver(page, picker.locator("[data-emoji]").first()), "an emoji").toBe(
		"pointer",
	);
	expect(await cursorOver(page, picker.getByRole("textbox")), "the search field").toBe("text");
});

test("a picture that opens the viewer zooms; a disabled control keeps the arrow", async ({ page }) => {
	let picture = plate(page, "chat-media").getByRole("button", { name: /^Open image: / }).first();
	expect(await cursorOver(page, picture)).toBe("zoom-in");

	let disabled: [string, Locator][] = [
		["a disabled button", plate(page, "buttons").locator("button.btn:disabled").first()],
		["a disabled send", plate(page, "chat").getByRole("button", { name: "Send message" }).first()],
		[
			"a disabled menu item",
			plate(page, "menus").getByRole("menuitem", { name: "Restore document" }),
		],
	];
	for (let [name, control] of disabled) {
		await expect(control, name).toBeDisabled();
		expect(await cursorOver(page, control), name).toBe("default");
	}
});

test("editable text shows the text cursor", async ({ page }) => {
	// A field computes `text`; a contenteditable leaves `auto`, which the browser draws as the
	// I-beam over editable text, and nothing above it may have put another cursor there.
	expect(await cursorOver(page, plate(page, "fields").getByRole("textbox").first())).toBe("text");
	let draft = plate(page, "chat").locator('[contenteditable="true"]').first();
	expect(await cursorOver(page, draft)).toMatch(/^(auto|text)$/);
});
