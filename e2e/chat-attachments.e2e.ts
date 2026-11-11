/**
 * Images and files in Chat, in a real browser against the real server and its storage: adding them
 * by the +, a drop and a paste, their progress, removal and refusals, sending them, and a
 * second person reading them. The fake GitHub decides who can read and who can write.
 */
import AxeBuilder from "@axe-core/playwright";

import {
	chat,
	chip,
	choose,
	composer,
	drop,
	leave,
	NOTES,
	paste,
	plus,
	PNG,
	SHOT,
	strip,
} from "./chat-attachments";
import { chatInput, expectChatValue, fillChat } from "./chat-input";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { authenticate, expect, roomPath, test } from "./room";

import type { Browser, Locator, Page } from "@playwright/test";

const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};

async function openChat(page: Page): Promise<void> {
	let tab = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ });
	if (await tab.isVisible()) await tab.click();
	await expect(chatInput(chat(page))).toBeVisible();
}

async function expectAccessible(page: Page): Promise<void> {
	// The files above the text and the row that adds them: the field is the composer's existing combobox.
	let result = await new AxeBuilder({ page }).include(".composer-staging").include(".composer-row")
		.analyze();
	expect(
		result.violations.map(violation =>
			`${violation.id}: ${violation.help} ${violation.nodes.map(node => node.html).join(" ")}`
		),
	).toEqual([]);
}

/** A person who can read the document and not write to it, in a page of their own. */
async function readerOf(browser: Browser, baseURL: string, room: string, suffix: string) {
	let context = await browser.newContext({ baseURL });
	let page = await context.newPage();
	await authenticate(page, `score-reader-${suffix}`, baseURL);
	await page.goto(roomPath(room));
	await expect(chat(page)).toBeVisible();
	return page;
}

function messages(page: Page) {
	return chat(page).locator("[data-chat-message-id]");
}

/** The address a sent image's tile is drawn from. */
async function pictureUrl(tile: Locator): Promise<string> {
	return tile.locator("span[aria-hidden]").first().evaluate(
		node => /url\("?([^")]+)"?\)/.exec(getComputedStyle(node).backgroundImage)![1]!,
	);
}

test("adds a file with the +, shows its name and size, and takes it away again", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	await expect(strip(page)).toHaveCount(0);
	await expect(plus(page)).toBeEnabled();

	await choose(page, NOTES);
	let notes = chip(page, "notes.md");
	await expect(notes).toBeVisible();
	await expect(notes).toContainText("25 B");
	// Once the server has it the chip is done: no bar, no percent, and a way to take it out.
	await expect(notes.locator("[aria-hidden][style*='width']")).toHaveCount(0);
	await expect(notes).toHaveAttribute("data-state", "done");

	let removed = page.waitForRequest(request =>
		request.method() === "DELETE" && /\/attachments\/[^/]+$/.test(request.url())
	);
	await notes.getByRole("button", { name: "Remove notes.md" }).click();
	await removed;
	await expect(strip(page)).toHaveCount(0);
});

test("adds an image by dropping it on the composer and a file by pasting it into the field", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);

	// Over the composer, the edge says what a drop does; away from it, it does not.
	await drop(page, [SHOT], { over: true });
	await expect(composer(page).locator(".composer-surface")).toHaveAttribute(
		"data-dropping",
		"true",
	);
	await leave(page);
	await expect(composer(page).locator(".composer-surface")).not.toHaveAttribute(
		"data-dropping",
		"true",
	);

	await drop(page, [SHOT]);
	let shot = chip(page, "shot.png");
	await expect(shot).toBeVisible();
	await expect(shot).toHaveAttribute("data-state", "done");
	// An image is drawn as itself.
	await expect(shot.locator("img")).toBeVisible();
	await expect.poll(() =>
		shot.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)
	)
		.toBe(2);

	await paste(page, [{ ...NOTES, name: "pasted.md" }]);
	await expect(chip(page, "pasted.md")).toHaveAttribute("data-state", "done");
	// The name a copied file brings as text is not typed into the draft.
	await expectChatValue(chatInput(chat(page)), "");
	await paste(page, [], "plain text still pastes");
	await expectChatValue(chatInput(chat(page)), "plain text still pastes");
});

test("keeps the drop edge while a drag moves between the composer's own parts, and drops it when the drag ends anywhere", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	let surface = composer(page).locator(".composer-surface");
	await drop(page, [SHOT], { over: true });
	await expect(surface).toHaveAttribute("data-dropping", "true");
	// Moving into the row of controls is not leaving.
	await leave(page, ".composer-row");
	await expect(surface).toHaveAttribute("data-dropping", "true");
	await leave(page);
	await expect(surface).not.toHaveAttribute("data-dropping", "true");
	// A drag that ends somewhere else, by a drop or by Escape, does not leave it lit.
	await drop(page, [SHOT], { over: true });
	await expect(surface).toHaveAttribute("data-dropping", "true");
	await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
	await expect(surface).not.toHaveAttribute("data-dropping", "true");
	await drop(page, [SHOT], { over: true });
	await page.evaluate(() => window.dispatchEvent(new Event("drop")));
	await expect(surface).not.toHaveAttribute("data-dropping", "true");
	await expect(strip(page)).toHaveCount(0);
});

/** Holds every upload where it is until `release`, then lets it go on or fails it. */
async function hold(page: Page) {
	let open!: (outcome: "go" | "fail") => void;
	let gate = new Promise<"go" | "fail">(resolve => (open = resolve));
	let held = 0;
	await page.route(/\/api\/channels\/[^/]+\/attachments\?/, async route => {
		held++;
		if (await gate === "fail") await route.abort("connectionreset");
		else await route.continue();
	});
	return {
		release: () => open("go"),
		fail: () => open("fail"),
		held: () => held,
	};
}

test("shows an upload as running while it goes, and as done once the server has the file", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	let upload = await hold(page);
	await choose(page, NOTES);
	let notes = chip(page, "notes.md");
	await expect(notes).toHaveAttribute("data-state", "uploading");
	// The chip says how far it is as a percent, and draws a bar along its foot, which is gone when it is done.
	await expect(notes).toContainText("0%");
	await expect(notes.locator("[aria-hidden][style*='width']")).toBeAttached();
	await expect.poll(() => upload.held()).toBe(1);
	upload.release();
	await expect(notes).toHaveAttribute("data-state", "done");
	await expect(notes.locator("[aria-hidden][style*='width']")).toHaveCount(0);
	await expect(notes).toContainText("25 B");
});

for (
	let refusal of [
		{
			name: "logo.svg",
			mimeType: "image/svg+xml",
			buffer: Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			),
			reason: "logo.svg isn't a PNG, JPEG, WebP or GIF image.",
		},
		{
			name: "evil.png",
			mimeType: "image/png",
			buffer: Buffer.from("<!doctype html><script>alert(1)</script>"),
			reason: "evil.png isn't a PNG, JPEG, WebP or GIF image.",
		},
		{
			name: "archive.zip",
			mimeType: "application/zip",
			buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]),
			reason: "archive.zip isn't an image (PNG, JPEG, WebP or GIF) or a text file.",
		},
		{
			name: "big.txt",
			mimeType: "text/plain",
			buffer: Buffer.alloc(1_048_577, 0x61),
			reason: "big.txt is over the 1 MB limit for a file.",
		},
		{
			name: "empty.txt",
			mimeType: "text/plain",
			buffer: Buffer.alloc(0),
			reason: "empty.txt is empty.",
		},
	]
) {
	test(`refuses ${refusal.name} in the browser, says why, and holds the message back until it is removed`, async ({ join }) => {
		let page = await join("ana");
		await openChat(page);
		let uploads = 0;
		page.on("request", request => {
			if (request.method() === "POST" && request.url().includes("/attachments")) uploads++;
		});
		let input = chatInput(chat(page));
		await fillChat(input, "Look at this");
		await choose(page, refusal);
		let refused = chip(page, refusal.name);
		await expect(refused).toHaveAttribute("data-state", "error");
		await expect(refused).toContainText(refusal.reason);
		// Said once, to a screen reader, as it appears.
		await expect(composer(page).getByRole("alert").filter({ hasText: refusal.reason })).toHaveCount(
			1,
		);
		// Nothing a refused file could be tried again for, and none of it left the browser.
		await expect(refused.getByRole("button", { name: /again/ })).toHaveCount(0);
		expect(uploads).toBe(0);
		await expect(composer(page).getByRole("button", { name: "Send message" })).toBeDisabled();
		await input.press("Enter");
		await expect(messages(page)).toHaveCount(0);
		await expectChatValue(input, "Look at this");

		await refused.getByRole("button", { name: `Remove ${refusal.name}` }).click();
		await expect(strip(page)).toHaveCount(0);
		await expect(composer(page).getByRole("button", { name: "Send message" })).toBeEnabled();
	});
}

test("refuses the sixth file of a message, and one the document's server says no to", async ({ join, page: first }) => {
	let page = await join("ana");
	await openChat(page);
	for (let index = 0; index < 6; index++) {
		await choose(page, {
			name: `note-${index}.txt`,
			mimeType: "text/plain",
			buffer: Buffer.from(`note ${index}`),
		});
	}
	await expect(strip(page).getByRole("listitem")).toHaveCount(6);
	await expect(chip(page, "note-5.txt")).toHaveAttribute("data-state", "error");
	await expect(chip(page, "note-5.txt")).toContainText("A message can carry up to 5 files.");
	for (let index = 0; index < 5; index++) {
		await expect(chip(page, `note-${index}.txt`)).toHaveAttribute("data-state", "done");
	}
	expect(first).toBe(page);
});

test("shows an upload that did not get through, and sends it again from the chip", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	let route = /\/api\/channels\/[^/]+\/attachments\?/;
	await page.route(route, request => request.abort("connectionreset"));
	await choose(page, NOTES);
	let notes = chip(page, "notes.md");
	await expect(notes).toHaveAttribute("data-state", "error");
	await expect(notes).toContainText("notes.md didn't upload.");
	await expect(composer(page).getByRole("alert").filter({ hasText: "notes.md didn't upload." }))
		.toHaveCount(1);
	await expect(composer(page).getByRole("button", { name: "Send message" })).toBeDisabled();

	await page.unroute(route);
	await notes.getByRole("button", { name: "Try notes.md again" }).click();
	await expect(notes).toHaveAttribute("data-state", "done");
	await expect(notes.getByRole("button", { name: /again/ })).toHaveCount(0);
});

test("sends the message with its files, and a second person reads them", async ({ join, room, baseURL, browser }) => {
	let suffix = crypto.randomUUID().slice(0, 8);
	let ana = await join("ana");
	let reader = await readerOf(browser, baseURL!, room, suffix);
	await openChat(ana);

	let input = chatInput(chat(ana));
	await fillChat(input, "The plan and a picture of the cap");
	await choose(ana, SHOT, NOTES);
	await expect(chip(ana, "shot.png")).toHaveAttribute("data-state", "done");
	await expect(chip(ana, "notes.md")).toHaveAttribute("data-state", "done");
	await input.press("Enter");

	// The composer is empty at once; the message is in Chat with its files, for both of them.
	await expect(strip(ana)).toHaveCount(0);
	await expectChatValue(input, "");
	for (let page of [ana, reader]) {
		let message = messages(page).filter({ hasText: "The plan and a picture of the cap" });
		await expect(message).toHaveCount(1);
		let files = message.getByRole("group", { name: "Files sent with this message" });
		await expect(files.getByRole("button", { name: /^shot\.png/ })).toBeVisible();
		await expect(files.getByRole("button", { name: /^notes\.md/ })).toBeVisible();
		// The tile of an image is drawn from the stored file itself.
		let url = await pictureUrl(files.getByRole("button", { name: /^shot\.png/ }));
		expect(
			await page.evaluate(async source => {
				let picture = new Image();
				picture.src = source;
				await picture.decode();
				return picture.naturalWidth;
			}, url),
		).toBe(2);
	}
	let message = messages(reader).filter({ hasText: "The plan and a picture of the cap" });
	let files = message.getByRole("group", { name: "Files sent with this message" });
	let image = await pictureUrl(files.getByRole("button", { name: /^shot\.png/ }));
	// Pressing an image opens it in a tab of its own; pressing a text file downloads it under its name.
	let [popup] = await Promise.all([
		reader.waitForEvent("popup"),
		files.getByRole("button", { name: /^shot\.png/ }).click(),
	]);
	expect(popup.url()).toBe(image);
	await popup.close();
	let [saved] = await Promise.all([
		reader.waitForEvent("download"),
		files.getByRole("button", { name: /^notes\.md/ }).click(),
	]);
	expect(saved.suggestedFilename()).toBe("notes.md");
	let notes = saved.url();

	// Read by a person who can read the document, as what its bytes are and never as a page.
	let seen = await reader.request.get(image);
	expect(seen.status()).toBe(200);
	expect(seen.headers()["content-type"]).toBe("image/png");
	expect(seen.headers()["x-content-type-options"]).toBe("nosniff");
	expect(seen.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
	expect(Buffer.compare(await seen.body(), PNG)).toBe(0);
	let download = await reader.request.get(notes);
	expect(download.status()).toBe(200);
	expect(download.headers()["content-type"]).toBe("text/plain; charset=utf-8");
	expect(download.headers()["content-disposition"]).toMatch(/^attachment;/);
	expect(await download.text()).toBe(NOTES.buffer.toString());

	// Not by someone who cannot read it, nor by someone not signed in: the same answer as for a file that is not there.
	let outsider = await browser.newContext({ baseURL: baseURL! });
	let stranger = await outsider.newPage();
	await authenticate(stranger, `score-outsider-${suffix}`, baseURL!);
	for (let path of [image, notes]) {
		let refused = await stranger.request.get(path);
		expect(refused.status(), path).toBe(404);
		expect(await refused.text()).toBe("file not found");
	}
	let nobody = await browser.newContext({ baseURL: baseURL! });
	expect((await nobody.request.get(image)).status()).toBe(404);
	let missing = await reader.request.get(image.replace(/[^/]+$/, "missing"));
	expect(missing.status()).toBe(404);
	expect(await missing.text()).toBe("file not found");
	await outsider.close();
	await nobody.close();
	expect(room).toContain("-");
});

test("holds a person who can only read the document to reading it, on the server as in the composer", async ({ room, baseURL, browser }) => {
	let reader = await readerOf(browser, baseURL!, room, crypto.randomUUID().slice(0, 8));
	await expect(composer(reader).getByText("Read-only access")).toBeVisible();
	await expect(plus(reader)).toHaveCount(0);
	// Whatever the composer offers, the server decides.
	let refused = await reader.request.post(
		`${baseURL}/api/channels/${room}/attachments?name=a.txt`,
		{
			data: "hello",
			headers: { origin: baseURL!, "content-type": "application/octet-stream" },
		},
	);
	expect(refused.status()).toBe(403);
	expect((await refused.json()).reason).toBe("not-allowed");
});

test("checks again on the server what the browser checked, by the bytes", async ({ join, room, baseURL }) => {
	let page = await join("ana");
	let post = (name: string, data: Buffer | string, type?: string) =>
		page.request.post(
			`${baseURL}/api/channels/${room}/attachments?name=${encodeURIComponent(name)}${
				type ? `&type=${encodeURIComponent(type)}` : ""
			}`,
			{ data, headers: { origin: baseURL!, "content-type": "application/octet-stream" } },
		);
	let page404 = await post("evil.png", "<!doctype html><script>alert(1)</script>", "image/png");
	expect(page404.status()).toBe(422);
	expect((await page404.json()).reason).toBe("image-type");
	let svg = await post("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml");
	expect(svg.status()).toBe(422);
	let big = await post("big.txt", Buffer.alloc(1_048_577, 0x61), "text/plain");
	expect(big.status()).toBe(413);
	expect((await big.json()).reason).toBe("too-large");
	let binary = await post("notes.txt", Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), "text/plain");
	expect(binary.status()).toBe(422);
	expect((await binary.json()).reason).toBe("unsupported");
	// A PNG called notes.txt is kept as what it is.
	let picture = await post("notes.txt", PNG, "text/plain");
	expect(picture.status()).toBe(201);
	expect((await picture.json()).attachment).toMatchObject({ kind: "image", mimeType: "image/png" });
	// Another origin cannot upload on a person's behalf.
	let foreign = await page.request.post(`${baseURL}/api/channels/${room}/attachments?name=a.txt`, {
		data: "hi",
		headers: { origin: "https://evil.example", "content-type": "application/octet-stream" },
	});
	expect(foreign.status()).toBe(403);
});

test("a message sent before its files have uploaded waits for them, and goes when they are done", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	let upload = await hold(page);
	let input = chatInput(chat(page));
	await fillChat(input, "Sent too soon");
	await choose(page, NOTES);
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "uploading");
	await input.press("Enter");
	await expect(
		composer(page).getByRole("status").filter({ hasText: "Sending once your files have uploaded" }),
	).toBeVisible();
	await expect(input).toHaveAttribute("aria-readonly", "true");
	await expect(messages(page)).toHaveCount(0);
	await expect.poll(() => upload.held()).toBe(1);

	upload.release();
	let message = messages(page).filter({ hasText: "Sent too soon" });
	await expect(message).toHaveCount(1);
	await expect(message.getByRole("button", { name: /^notes\.md/ })).toBeVisible();
	await expect(strip(page)).toHaveCount(0);
	await expectChatValue(input, "");
	await expect(input).toHaveAttribute("aria-readonly", "false");
});

test("a message whose file fails while it waits is given back to the composer with its text and its files", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	let upload = await hold(page);
	let input = chatInput(chat(page));
	await fillChat(input, "Sent too soon");
	await choose(page, NOTES);
	await input.press("Enter");
	await expect(composer(page).getByText("Sending once your files have uploaded")).toBeVisible();

	upload.fail();
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "error");
	await expect(composer(page).getByText("Sending once your files have uploaded")).toHaveCount(0);
	await expect(input).toHaveAttribute("aria-readonly", "false");
	await expectChatValue(input, "Sent too soon");
	await expect(messages(page)).toHaveCount(0);

	// Tried again, it goes through and the message can be sent as it was.
	await page.unroute(/\/api\/channels\/[^/]+\/attachments\?/);
	await chip(page, "notes.md").getByRole("button", { name: "Try notes.md again" }).click();
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "done");
	await input.press("Enter");
	await expect(messages(page).filter({ hasText: "Sent too soon" })).toHaveCount(1);
});

test("a message may be only a picture", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	await choose(page, SHOT);
	await expect(chip(page, "shot.png")).toHaveAttribute("data-state", "done");
	await composer(page).getByRole("button", { name: "Send message" }).click();
	let message = messages(page).filter({ has: page.locator("[data-slot='message-attachments']") });
	await expect(message).toHaveCount(1);
	await expect(message).not.toContainText("Ask Chopin");
});

test("keeps the composer's files usable at a phone's width, and accessible", async ({ join }) => {
	let page = await join("ana", PHONE);
	await openChat(page);
	// The + is in the row at rest, and the box does not move when the field takes the focus.
	let surface = composer(page).locator(".composer-surface");
	await expect(plus(page)).toBeVisible();
	// Measured once the pane has slid in and come to rest.
	await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
	let resting = (await surface.boundingBox())!;
	await chatInput(chat(page)).tap();
	await expect(plus(page)).toBeVisible();
	let focused = (await surface.boundingBox())!;
	expect(focused).toEqual(resting);
	await choose(page, SHOT, NOTES, {
		name: "logo.svg",
		mimeType: "image/svg+xml",
		buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
	});
	await expect(chip(page, "shot.png")).toHaveAttribute("data-state", "done");
	await expect(chip(page, "logo.svg")).toHaveAttribute("data-state", "error");
	// The pane slides in under the tab bar; what is measured is where it comes to rest.
	await expect(async () => {
		for (let name of ["shot.png", "notes.md", "logo.svg"]) {
			await expectInsideViewport(chip(page, name));
		}
		await expectInsideViewport(plus(page));
	}).toPass({ timeout: 10_000 });
	await expectNoHorizontalOverflow(page);
	await expectAccessible(page);
	await chip(page, "logo.svg").getByRole("button", { name: "Remove logo.svg" }).click();
	await chatInput(chat(page)).fill("From a phone");
	await composer(page).getByRole("button", { name: "Send message" }).click();
	await expect(
		messages(page).filter({ hasText: "From a phone" }).locator("[data-slot='message-attachments']"),
	).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("is accessible on desktop with files waiting, refused and uploading", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	await choose(page, SHOT, {
		name: "logo.svg",
		mimeType: "image/svg+xml",
		buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
	});
	await expect(chip(page, "logo.svg")).toHaveAttribute("data-state", "error");
	await expectAccessible(page);
});

test("two files with one name are two: removing one leaves the other", async ({ join }) => {
	let page = await join("ana");
	await openChat(page);
	let other = Buffer.concat([PNG, Buffer.from([0])]);
	// A pasted screenshot is always called image.png.
	await paste(page, [{ name: "image.png", mimeType: "image/png", buffer: PNG }]);
	await paste(page, [{ name: "image.png", mimeType: "image/png", buffer: other }]);
	let chips = strip(page).getByRole("listitem");
	await expect(chips).toHaveCount(2);
	await expect(chips.nth(0)).toHaveAttribute("data-state", "done");
	await expect(chips.nth(1)).toHaveAttribute("data-state", "done");
	let first = await chips.nth(0).getAttribute("data-file-id");
	let removed = page.waitForRequest(request => request.method() === "DELETE");
	await chips.nth(1).getByRole("button", { name: "Remove image.png" }).click();
	await removed;
	await expect(chips).toHaveCount(1);
	await expect(chips.nth(0)).toHaveAttribute("data-file-id", first!);
});
