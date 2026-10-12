/** The focus ring is keyboard-only, except on text fields. */

import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

function outlineStyle(target: Locator) {
	return target.evaluate(element => getComputedStyle(element).outlineStyle);
}

function isTextField(target: Locator) {
	return target.evaluate(element =>
		element.matches('input, textarea, [contenteditable="true"], [role="combobox"]')
	);
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
	// Chat has no header now, so the first stop is the composer, a text field that
	// is exempt from the ring; walk on to the next non-text control.
	for (let step = 0; step < 4 && (await isTextField(next)); step += 1) {
		await page.keyboard.press("Tab");
		next = page.locator(":focus");
	}
	expect(await isTextField(next)).toBe(false);
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
	await page.getByRole("group", { name: /^Document: / }).getByRole("button", {
		name: /^Actions for /,
	}).click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	let field = page.getByRole("textbox", { name: "Document title" });
	await field.click();
	await expect(field).toBeFocused();
	expect(await modality(page)).toBe("pointer");
	expect(await outlineStyle(field)).toBe("solid");
});

function composer(page: Page) {
	return page.locator(".chat-composer .composer-surface");
}

/** The ring stands off the frame; the quieter pointer edge sits on it. */
function outlineOffset(target: Locator) {
	return target.evaluate(element => getComputedStyle(element).outlineOffset);
}

test("a click into the Chat composer shows only its edge, even while typing", async ({ join }) => {
	let page = await join("ana");
	let input = composer(page).getByRole("combobox", { name: "Message" });
	await input.click();
	await expect(input).toBeFocused();
	await page.keyboard.type("hello");
	expect(await modality(page)).toBe("keyboard");
	expect(await outlineStyle(composer(page))).toBe("solid");
	expect(await outlineOffset(composer(page))).toBe("0px");
});

test("Tab into the Chat composer shows its whole ring", async ({ join }) => {
	let page = await join("ana");
	await handle(page).click();
	await page.keyboard.press("Tab");
	await expect(composer(page).getByRole("combobox", { name: "Message" })).toBeFocused();
	expect(await outlineStyle(composer(page))).toBe("solid");
	expect(await outlineOffset(composer(page))).toBe("2px");
	// No ancestor that clips vertically may cut the ring off below the composer.
	let clipped = await composer(page).evaluate(element => {
		let style = getComputedStyle(element);
		let reach = element.getBoundingClientRect().bottom + parseFloat(style.outlineWidth)
			+ parseFloat(style.outlineOffset);
		let clips = [];
		for (let parent = element.parentElement; parent; parent = parent.parentElement) {
			if (getComputedStyle(parent).overflowY === "visible") continue;
			if (parent.getBoundingClientRect().bottom < reach) clips.push(parent.className);
		}
		return clips;
	});
	expect(clipped).toEqual([]);
});
