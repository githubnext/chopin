import { expect, test } from "./room";
import { createChannel } from "./database";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function title(id: string) {
	return `Test ${id.slice(0, 8)}`;
}

function documentsButton(page: Page) {
	return page.locator(".phone-top-bar").getByRole("button", { name: "Documents", exact: true });
}

function sheet(page: Page) {
	return page.getByRole("dialog", { name: "Documents" });
}

async function otherDocument(baseURL: string): Promise<string> {
	let id = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL).port), id);
	return id;
}

test("a phone opens its documents in a bottom sheet over an inert page", async ({ join }) => {
	let page = await join("ana", PHONE);
	let opener = documentsButton(page);
	let before = await page.getByRole("banner").boundingBox();
	await opener.click();
	await expect(sheet(page)).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Projects" })).toHaveCount(0);
	await expect(sheet(page).getByRole("button", { name: "Close documents" }).first()).toBeFocused();
	await expect(page.locator(".navigation-shell")).toHaveAttribute("inert", "");
	expect(await page.getByRole("banner", { includeHidden: true }).boundingBox()).toEqual(before);
	await expect(sheet(page).getByRole("button", { name: "Keyboard shortcuts" })).toHaveCount(0);
	let search = sheet(page).getByRole("searchbox", { name: "Search documents" });
	expect(await search.evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
		.toBeGreaterThanOrEqual(16);
	let row = sheet(page).locator(".documents-sheet-link").first();
	expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expect(sheet(page).getByRole("button", { name: "New document" })).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(sheet(page)).toHaveCount(0);
	await expect(opener).toBeFocused();
	await expect(page.locator(".navigation-shell")).not.toHaveAttribute("inert", "");

	await opener.click();
	await expect(sheet(page)).toBeVisible();
	let box = (await sheet(page).boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + 12);
	await page.mouse.down();
	for (let step = 1; step <= 12; step++) {
		await page.mouse.move(box.x + box.width / 2, box.y + 12 + step * 40);
	}
	await page.mouse.up();
	await expect(sheet(page)).toHaveCount(0);
});

test("the documents sheet filters inline and navigates to a document", async ({ baseURL, join, room }) => {
	let other = await otherDocument(baseURL!);
	let page = await join("ana", PHONE);
	await documentsButton(page).click();
	let documents = sheet(page).getByRole("region", { name: "Documents" });
	await expect(documents.getByRole("link", { name: title(room) })).toBeVisible();

	await sheet(page).getByRole("searchbox", { name: "Search documents" }).fill(
		title(other).toUpperCase(),
	);
	await expect(documents.getByRole("link")).toHaveCount(1);
	await expect(documents.getByRole("link", { name: title(other) })).toBeVisible();

	await documents.getByRole("link", { name: title(other) }).click();
	await expect(sheet(page)).toHaveCount(0);
	await expect(page.locator(".phone-top-bar")).toContainText(title(other));
});

test("archived documents push a page inside the sheet and come back", async ({ join }) => {
	let page = await join("ana", PHONE);
	await documentsButton(page).click();
	let archivedPage = page.locator('[data-sheet-page="archived"]');
	await expect(archivedPage).toHaveAttribute("inert", "");
	await sheet(page).getByRole("button", { name: "Archived", exact: true }).click();
	await expect(archivedPage).not.toHaveAttribute("inert", "");
	await expect(page.locator('[data-sheet-page="documents"]')).toHaveAttribute("inert", "");
	let back = sheet(page).getByRole("button", { name: "Back to documents" });
	await expect(back).toBeFocused();
	await expect(sheet(page).getByRole("heading", { name: "Archived" })).toBeVisible();

	await back.click();
	await expect(archivedPage).toHaveAttribute("inert", "");
	await expect(sheet(page).getByRole("button", { name: "Archived", exact: true })).toBeFocused();
	await expect(sheet(page)).toBeVisible();
});

test("document menus open an action sheet on a phone", async ({ baseURL, join, room }) => {
	let other = await otherDocument(baseURL!);
	let page = await join("ana", PHONE);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	let more = page.locator(".phone-top-bar").getByRole("button", {
		name: `Actions for ${title(room)}`,
	});

	await more.click();
	let actions = page.getByRole("dialog", { name: `Actions for ${title(room)}` });
	await expect(actions).toBeVisible();
	await expect(page.getByRole("menu")).toHaveCount(0);
	for (let label of ["Copy link", "Rename", "Archive", "Cancel"]) {
		let item = actions.getByRole("button", { name: label, exact: true });
		await expect(item).toBeVisible();
		expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(56);
	}
	await actions.getByRole("button", { name: "Cancel" }).click();
	await expect(actions).toHaveCount(0);

	await more.click();
	await actions.getByRole("button", { name: "Copy link", exact: true }).click();
	await expect(actions).toHaveCount(0);
	await expect(page.getByText("Link copied")).toBeVisible();

	// Tapping the title reads it; renaming is an action.
	await page.locator(".phone-top-bar-title").click();
	await expect(page.getByRole("textbox", { name: "Document title" })).toHaveCount(0);
	await more.click();
	await actions.getByRole("button", { name: "Rename", exact: true }).click();
	let field = page.getByRole("textbox", { name: "Document title" });
	await expect(field).toBeFocused();
	expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
		.toBeGreaterThanOrEqual(16);
	await field.press("Escape");
	await expect(field).toHaveCount(0);

	await documentsButton(page).click();
	await sheet(page).getByRole("button", { name: `Actions for ${title(other)}` }).click();
	let rowActions = page.getByRole("dialog", { name: `Actions for ${title(other)}` });
	await rowActions.getByRole("button", { name: "Archive", exact: true }).click();
	await expect(rowActions).toHaveCount(0);
	await expect(page.getByText(`Archived ${title(other)}`)).toBeVisible();
	await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
});

test("desktop keeps the Projects sidebar and popover menus", async ({ join, room }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await expect(page.getByRole("complementary", { name: "Projects" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveCount(0);
	await page.getByRole("banner").getByRole("button", { name: `Actions for ${title(room)}` })
		.click();
	await expect(page.getByRole("menu", { name: `Actions for ${title(room)}` })).toBeVisible();
	await expect(page.getByRole("dialog", { name: /^Actions for / })).toHaveCount(0);

	let narrow = await join("ana", { viewport: { width: 900, height: 900 } });
	await narrow.getByRole("button", { name: "Show sidebar" }).click();
	await expect(narrow.getByRole("dialog", { name: "Projects" })).toBeVisible();
	await expect(narrow.getByRole("dialog", { name: "Documents" })).toHaveCount(0);
});
