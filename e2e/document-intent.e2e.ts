/**
 * A document's record is read when the reader shows signs of opening it, and the click uses that read.
 *
 * What counts as a sign, and how long a read stays usable, is `document-intent.test.ts`; that the
 * Projects list really sends it, that opening afterwards does not ask the server again, and that
 * such a read changes nothing the reader sees when it goes wrong or is out of date, is browser
 * behaviour.
 */

import { FRESH_MS } from "../apps/web/src/document-intent";
import { createChannel, seedChannel, testChannelSlug } from "./database";
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
	return { id, slug: testChannelSlug(id), title: `Test ${id.slice(0, 8)}`, text };
}

/**
 * The Projects list holds every document the run's other tests make in the repository, newest
 * first, and the page reads it again whenever one of them creates or renames one. A row that comes
 * in above the pointer moves the rows beneath it, and the browser then says the pointer is on
 * another row though it has not moved, so a document the test rests on, presses or focuses is not
 * the one that is read. The list answers with the documents this test made, which only it
 * changes, as the document-navigation tests do for theirs; the reads and the openings are the
 * server's own.
 */
async function listOnly(
	page: Page,
	room: string,
	documents: { id: string; slug: string; title: string }[],
) {
	let own = { id: room, slug: testChannelSlug(room), title: `Test ${room.slice(0, 8)}` };
	await page.route("**/api/repositories/octo-org/score/channels*", route =>
		route.fulfill({
			json: {
				canEdit: true,
				channels: [own, ...documents].map(({ id, slug, title }) => ({
					createdAt: "2026-08-19T12:00:00.000Z",
					createdBy: "U_ana",
					descriptionRevision: 0,
					id,
					repositoryId: "R_score",
					repositoryName: "score",
					repositoryOwner: "octo-org",
					revision: 0,
					slug,
					title,
					updatedAt: "2026-08-19T12:00:00.000Z",
				})),
				repository: {
					defaultBranch: "main",
					fullName: "octo-org/score",
					id: "R_score",
					name: "score",
					owner: "octo-org",
					ownerAvatarUrl: "https://example.invalid/octo-org.png",
					permissions: { admin: false, pull: true, push: true },
					private: true,
					url: "https://github.com/octo-org/score",
				},
			},
		}));
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

/** The id of the document in each notice of a change that the page's sidebar socket receives, from now on. */
function watchChanges(page: Page) {
	let changed: string[] = [];
	page.on("websocket", socket => {
		if (new URL(socket.url()).pathname !== "/ws/sidebar") return;
		socket.on("framereceived", ({ payload }) => {
			let frame = JSON.parse(String(payload)) as { kind: string; channelId?: string };
			if (frame.kind === "sidebar:catalogue" && frame.channelId) changed.push(frame.channelId);
		});
	});
	return changed;
}

async function opened(page: Page, document: { title: string; text: string }) {
	await expect(page.getByRole("group", { name: `Document: ${document.title}` })).toBeVisible();
	await expect(page.getByText(document.text, { exact: true })).toBeVisible();
}

test("a document is read when the pointer rests on its row, the row is pressed or the keyboard rests on it, and the click does not read it again", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let resting = await another(baseURL!, "The document the pointer rests on.");
	let pressed = await another(baseURL!, "The document that was pressed.");
	let focused = await another(baseURL!, "The document the focus rests on.");
	await listOnly(page, room, [resting, pressed, focused]);
	await join("ana");
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

test("opening a document nobody rested on reads it once, as before", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let clicked = await another(baseURL!, "The document that was only clicked.");
	await listOnly(page, room, [clicked]);
	await join("ana");
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

test("a read started at rest that fails after the click is replaced by the opening's own, and the document opens", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document whose first read fails.");
	await listOnly(page, room, [target]);
	await join("ana");
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

test("a read started at rest that the server turns away as signed out does not reload the page", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document whose first read is turned away.");
	await listOnly(page, room, [target]);
	await join("ana");
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

test("a click that comes a while after the pointer rested on a row reads the document again", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document that was read again.");
	await listOnly(page, room, [target]);
	await join("ana");
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

/** Rest the pointer on a row until the read that starts is answered. */
async function restOn(page: Page, target: { slug: string; title: string }) {
	let row = sidebar(page).getByRole("link", { name: target.title, exact: true });
	let answered = page.waitForResponse(response =>
		new URL(response.url()).pathname.endsWith(`/documents/${target.slug}`)
	);
	await row.hover();
	await answered;
	return row;
}

/**
 * Wait until the page has been told this many times that a document changed, and has acted on it.
 * The list the page is given keeps the row's old address, as a page does until it has read the list
 * again, and a renamed document is still opened by its old address, so the click that follows is
 * the one that could be given the record from before.
 */
async function toldOf(page: Page, told: string[], document: { id: string }, times: number) {
	await expect.poll(() => told.filter(id => id === document.id).length).toBeGreaterThanOrEqual(
		times,
	);
	// The page has acted on what it was told, not only had it arrive.
	await page.evaluate(() => new Promise(resolve => setTimeout(resolve)));
}

test("a record read at rest is not used once the document has been renamed, however soon the click comes", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document that was renamed.");
	await listOnly(page, room, [target]);
	// Both from before the page opens, for the socket that tells it of changes.
	let told = watchChanges(page);
	let reads = watchReads(page);
	let renamed = `Renamed ${target.id.slice(0, 8)}`;
	await join("ana");
	let row = await restOn(page, target);

	let response = await page.context().request.patch(`/api/channels/${target.id}`, {
		headers: { origin: new URL(baseURL!).origin },
		data: { title: renamed },
	});
	expect(response.ok()).toBe(true);
	await toldOf(page, told, target, 1);
	await row.click();

	// The opening read for itself, the second read of this address, and shows the document as it is.
	await opened(page, { title: renamed, text: target.text });
	expect(reads.filter(slug => slug === target.slug)).toHaveLength(2);
});

test("a record read at rest is not used once the document has been deleted, however soon the click comes", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document that was deleted.");
	await listOnly(page, room, [target]);
	let told = watchChanges(page);
	let reads = watchReads(page);
	await join("ana");
	let row = await restOn(page, target);

	// Archiving it is the first change the page is told of, and deleting it the second.
	let headers = { origin: new URL(baseURL!).origin };
	let archived = await page.context().request.post(`/api/channels/${target.id}/archive`, {
		headers,
	});
	expect(archived.ok()).toBe(true);
	let deleted = await page.context().request.delete(`/api/channels/${target.id}`, { headers });
	expect(deleted.ok()).toBe(true);
	await toldOf(page, told, target, 2);
	await row.click();

	// Only the server can say so: the record read at rest is of a document that was there.
	await expect(page.getByRole("heading", { name: "Document not found", level: 1 })).toBeVisible();
	expect(reads.filter(slug => slug === target.slug).length).toBeGreaterThanOrEqual(2);
});

test("a change to another document leaves the record read at rest for the click", async ({ baseURL, join, page, room, seed }) => {
	await seed("Original document.\n");
	let target = await another(baseURL!, "The document the pointer rested on.");
	let other = await another(baseURL!, "A document that is renamed meanwhile.");
	await listOnly(page, room, [target, other]);
	let told = watchChanges(page);
	let reads = watchReads(page);
	await join("ana");
	let row = await restOn(page, target);

	let response = await page.context().request.patch(`/api/channels/${other.id}`, {
		headers: { origin: new URL(baseURL!).origin },
		data: { title: `Renamed ${other.id.slice(0, 8)}` },
	});
	expect(response.ok()).toBe(true);
	await toldOf(page, told, other, 1);
	await row.click();

	await opened(page, target);
	expect(reads.filter(slug => slug === target.slug)).toHaveLength(1);
});
