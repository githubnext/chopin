/**
 * A document's record is read when the reader shows signs of opening it, and the click uses that read.
 *
 * What counts as a sign, and how long a read stays usable, is `document-intent.test.ts`; that the
 * Projects list really sends it, and that opening afterwards does not ask the server again, is
 * browser behaviour.
 */

import { createChannel, seedChannel } from "./database";
import { expect, test } from "./room";

import type { Page } from "@playwright/test";

function sidebar(page: Page) {
	return page.getByRole("complementary", { name: "Projects" });
}

/** A document of its own in the repository, whose row in the Projects list opens it. */
async function another(baseURL: string, text: string) {
	let id = crypto.randomUUID();
	let databasePort = Number(new URL(baseURL).port);
	await createChannel(databasePort, id);
	await seedChannel(databasePort, id, `${text}\n`);
	return { slug: `test-${id.slice(0, 8)}`, title: `Test ${id.slice(0, 8)}`, text };
}

/** Every request for a document's record, by its slug, from now on. */
function watchReads(page: Page) {
	let reads: string[] = [];
	page.on("request", request => {
		let { pathname } = new URL(request.url());
		let match = /^\/api\/repositories\/octo-org\/score\/documents\/([^/]+)$/.exec(pathname);
		if (match) reads.push(match[1]!);
	});
	return reads;
}

async function opened(page: Page, document: { title: string; text: string }) {
	await expect(page.getByRole("group", { name: `Document: ${document.title}` })).toBeVisible();
	await expect(page.getByText(document.text, { exact: true })).toBeVisible();
}

test("a document is read when the pointer rests on its row, the row is pressed or the keyboard rests on it, and the click does not read it again", async ({ baseURL, join, seed }) => {
	await seed("Original document.\n");
	let resting = await another(baseURL!, "The document the pointer rests on.");
	let pressed = await another(baseURL!, "The document that was pressed.");
	let focused = await another(baseURL!, "The document the focus rests on.");
	let page = await join("ana");
	let reads = watchReads(page);
	let row = (document: { title: string }) =>
		sidebar(page).getByRole("link", { name: document.title, exact: true });
	let readsOf = (document: { slug: string }) => reads.filter(slug => slug === document.slug).length;

	await test.step("the pointer rests on a row", async () => {
		await row(resting).hover();
		await expect.poll(() => readsOf(resting)).toBe(1);
		await row(resting).click();
		await opened(page, resting);
		expect(readsOf(resting)).toBe(1);
	});

	await test.step("a row is pressed", async () => {
		let box = (await row(pressed).boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await expect.poll(() => readsOf(pressed)).toBe(1);
		await page.mouse.up();
		await opened(page, pressed);
		expect(readsOf(pressed)).toBe(1);
	});

	await test.step("the keyboard rests on a row", async () => {
		// Script focus shows a focus ring only after the keyboard was the last input.
		await page.keyboard.press("Shift");
		await row(focused).focus();
		await expect.poll(() => readsOf(focused)).toBe(1);
		await page.keyboard.press("Enter");
		await opened(page, focused);
		expect(readsOf(focused)).toBe(1);
	});
});

test("opening a document nobody rested on reads it once, as before", async ({ baseURL, join, seed }) => {
	await seed("Original document.\n");
	let clicked = await another(baseURL!, "The document that was only clicked.");
	let page = await join("ana");
	let reads = watchReads(page);

	await sidebar(page).getByRole("link", { name: clicked.title, exact: true }).dispatchEvent(
		"click",
	);
	await opened(page, clicked);
	expect(reads.filter(slug => slug === clicked.slug)).toHaveLength(1);
});
