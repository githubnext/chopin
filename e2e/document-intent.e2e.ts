/**
 * A document's record is read when the reader shows signs of opening it, and the click uses that read.
 *
 * What counts as a sign, and how long a read stays usable, is `document-intent.test.ts`; that the
 * Projects list really sends it, that opening afterwards does not ask the server again, and that
 * such a read changes nothing the reader sees when it goes wrong or is out of date, is browser
 * behaviour.
 */

import { FRESH_MS } from "../apps/web/src/document-intent";
import { createChannel, seedChannel } from "./database";
import { expect, test } from "./room";

import type { Page, Route } from "@playwright/test";

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

/** Answer the first request for a document's record as `first` says; later ones go to the server. */
async function answerFirstRead(
	page: Page,
	document: { slug: string },
	first: (route: Route) => Promise<void>,
) {
	let reads = { count: 0 };
	await page.route(
		`**/api/repositories/octo-org/score/documents/${document.slug}`,
		async route => {
			reads.count += 1;
			await (reads.count === 1 ? first(route) : route.continue());
		},
	);
	return reads;
}

test("a read started at rest that fails after the click is replaced by the opening's own, and the document opens", async ({ baseURL, join, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document whose first read fails.");
	let page = await join("ana");
	let held = Promise.withResolvers<void>();
	let reads = await answerFirstRead(page, target, async route => {
		await held.promise;
		await route.fulfill({
			body: JSON.stringify({ error: "temporary" }),
			contentType: "application/json",
			status: 503,
		});
	});
	let row = sidebar(page).getByRole("link", { name: target.title, exact: true });

	await row.hover();
	await expect.poll(() => reads.count).toBe(1);
	await row.click();
	held.resolve();

	await opened(page, target);
	await expect(page.getByText("Couldn't open this document", { exact: true })).toHaveCount(0);
	expect(reads.count).toBe(2);
});

test("a read started at rest that the server turns away as signed out does not reload the page", async ({ baseURL, join, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document whose first read is turned away.");
	let page = await join("ana");
	let loads = 0;
	page.on("load", () => void (loads += 1));
	let turnedAway = false;
	let reads = await answerFirstRead(page, target, async route => {
		await route.fulfill({
			body: JSON.stringify({ error: "authentication required" }),
			contentType: "application/json",
			status: 401,
		});
		turnedAway = true;
	});
	let row = sidebar(page).getByRole("link", { name: target.title, exact: true });

	await row.hover();
	await expect.poll(() => turnedAway).toBe(true);
	// A reload, if one is coming, starts as soon as the page has read the answer.
	await page.waitForTimeout(500);
	expect(loads).toBe(0);
	await expect(page.getByText("Original document.", { exact: true })).toBeVisible();

	await row.click();
	await opened(page, target);
	expect(reads.count).toBe(2);
});

test("a click that comes a while after the pointer rested on a row reads the document again", async ({ baseURL, join, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document that was read again.");
	let page = await join("ana");
	let reads = watchReads(page);
	let row = sidebar(page).getByRole("link", { name: target.title, exact: true });
	let answered = page.waitForResponse(response =>
		new URL(response.url()).pathname.endsWith(`/documents/${target.slug}`)
	);

	await row.hover();
	await answered;
	// A record read this long ago is one the click does without, whatever has changed since.
	await page.waitForTimeout(FRESH_MS + 250);
	await row.click();

	await opened(page, target);
	expect(reads.filter(slug => slug === target.slug)).toHaveLength(2);
});
