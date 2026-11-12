/**
 * Chat's images, the placeholders of images that cannot load, and its files, drawn the way Slack
 * draws them, in a real browser against the real server: the image block and its own toolbar,
 * Slack's grid of two, three and four, the full-screen viewer, every placeholder, the file cards
 * sent and staged, a phone's width, and a photo too large to send whole that is sent and shown
 * anyway, from Slack's thumbnail widths.
 */
import { deflateSync } from "node:zlib";

import { chip, choose, composer, NOTES, PNG, strip } from "./chat-attachments";
import { chatInput, fillChat } from "./chat-input";
import { seedChannelImage } from "./database";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";

const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};

let CRC = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array {
	let body = new Uint8Array(4 + data.length);
	body.set(new TextEncoder().encode(type));
	body.set(data, 4);
	let crc = 0xffffffff;
	for (let byte of body) crc = CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	let out = new Uint8Array(12 + data.length);
	let view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(body, 4);
	view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
	return out;
}

/** A PNG of the given size, coloured by `pixel`, so a picture has something to show. */
function png(width: number, height: number, pixel = (x: number, y: number) => [x, y, 160]) {
	let rows = new Uint8Array(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		let at = y * (1 + width * 3);
		for (let x = 0; x < width; x++) rows.set(pixel(x, y).map(value => value % 256), at + 1 + x * 3);
	}
	let header = new Uint8Array(13);
	let view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows, { level: 1 })),
		chunk("IEND", new Uint8Array()),
	]);
}

function port(baseURL: string | undefined): number {
	return Number(new URL(baseURL!).port);
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function message(page: Page, id: string): Locator {
	return chat(page).locator(`[data-chat-message-id="${id}"]`);
}

function viewer(page: Page): Locator {
	return page.locator("[data-image-viewer]");
}

async function openChat(page: Page): Promise<void> {
	let tab = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ });
	if (await tab.isVisible()) await tab.click();
	await expect(chat(page)).toBeVisible();
	// A phone's pane slides in from the side; measure it once it has arrived.
	if ((page.viewportSize()?.width ?? 0) <= 600) {
		await expect.poll(async () => Math.round((await chat(page).boundingBox())?.x ?? -1)).toBe(0);
	}
}

function agent(id: string, images: Chat.Image[], ts = 1_700_000_000_000): Chat.Entry {
	return { id, author: { kind: "agent" }, text: `Message ${id}`, ts, images };
}

async function pictures(baseURL: string | undefined, room: string, count: number) {
	let stored: Chat.Image[] = [];
	for (let index = 0; index < count; index++) {
		let src = await seedChannelImage(
			port(baseURL),
			room,
			png(600, 400, (x, y) => [x + index * 50, y, 90 + index * 30]),
			"image/png",
		);
		stored.push({ src, alt: `Picture ${index + 1}`, width: 600, height: 400, generated: true });
	}
	return stored;
}

test("one image sits in Slack's frame under its message, at most 480 by 360, with its own toolbar on it", async ({ baseURL, join, room, seed }) => {
	let [wide] = await pictures(baseURL, room, 1);
	let tallSrc = await seedChannelImage(port(baseURL), room, png(300, 900), "image/png");
	await seed("# Images\n", {
		transcript: [
			agent("wide", [{ ...wide!, width: 1536, height: 1024 }]),
			agent(
				"tall",
				[{ src: tallSrc, alt: "A tall drawing", width: 300, height: 900 }],
				1_700_000_100_000,
			),
		],
	});
	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);

	let figure = message(page, "wide").locator('[data-chat-image="single"]');
	await expect(figure).toHaveAttribute("data-load", "shown");
	let frame = figure.locator(".chat-image-frame");
	await frame.scrollIntoViewIfNeeded();
	let box = (await frame.boundingBox())!;
	// A wide image takes Slack's `thumb_480` width, a 1px hairline either side.
	expect(box.width).toBeLessThanOrEqual(482);
	expect((box.width - 2) / (box.height - 2)).toBeCloseTo(1.5, 1);
	await expect(frame).toHaveCSS("border-radius", "8px");
	await expect(frame).toHaveCSS("border-top-width", "1px");
	// Its name is the line above it, as Slack's file meta is.
	let meta = (await figure.locator(".chat-image-meta").boundingBox())!;
	expect(meta.y + meta.height).toBeLessThanOrEqual(box.y);
	await expect(figure.locator(".chat-image-meta")).toHaveText(/Picture 1/);
	// It is read at Slack's thumbnail widths, never as its whole original.
	await expect(figure.locator("img")).toHaveAttribute("src", /\?document=[^&]+&w=480$/);
	expect(
		await figure.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth),
	).toBe(480);
	await expect.poll(() =>
		figure.locator("img").evaluate(image => (image as HTMLImageElement).currentSrc)
	)
		.toMatch(/&w=\d+$/);

	// The toolbar is the image's own, 10px in from its top-right corner, shown on hover.
	let toolbar = figure.locator(".chat-image-actions-slot");
	await expect(toolbar).toHaveCSS("opacity", "0");
	await frame.hover();
	await expect(toolbar).toHaveCSS("opacity", "1");
	box = (await frame.boundingBox())!;
	let bar = (await toolbar.boundingBox())!;
	expect(Math.round(box.x + box.width - (bar.x + bar.width))).toBe(10);
	expect(Math.round(bar.y - box.y)).toBe(10);
	for (let name of ["Open image", "Copy image", "Download image"]) {
		let button = toolbar.getByRole("button", { name });
		await expect(button).toBeVisible();
		let size = (await button.boundingBox())!;
		expect([size.width, size.height]).toEqual([32, 32]);
	}

	// A tall one is fitted to Slack's 360px height, keeping its shape.
	let tall = message(page, "tall").locator(".chat-image-frame");
	await expect(message(page, "tall").locator("[data-chat-image]")).toHaveAttribute(
		"data-load",
		"shown",
	);
	let tallBox = (await tall.boundingBox())!;
	expect(tallBox.height).toBeCloseTo(362, 0);
	expect((tallBox.width - 2) / (tallBox.height - 2)).toBeCloseTo(1 / 3, 2);
});

test("several images are Slack's grid: two side by side, three as one tall beside two, four in two rows, the rest behind +N", async ({ baseURL, join, room, seed }) => {
	let stored = await pictures(baseURL, room, 6);
	await seed("# Grid\n", {
		transcript: [
			agent("two", stored.slice(0, 2)),
			agent("three", stored.slice(0, 3), 1_700_000_100_000),
			agent("four", stored.slice(0, 4), 1_700_000_200_000),
			agent("six", stored, 1_700_000_300_000),
		],
	});
	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);

	let boxes = async (id: string) => {
		let tiles = message(page, id).locator('[data-chat-image="tile"]');
		for (let tile of await tiles.all()) await expect(tile).toHaveAttribute("data-load", "shown");
		return Promise.all((await tiles.all()).map(async tile => (await tile.boundingBox())!));
	};

	let [a, b] = await boxes("two");
	expect(a!.y).toBe(b!.y);
	expect(a!.width).toBeCloseTo(b!.width, 0);
	expect(a!.width).toBeCloseTo(a!.height, 0);
	expect(Math.round(b!.x - (a!.x + a!.width))).toBe(4);

	let [tallTile, top, bottom] = await boxes("three");
	expect(top!.x).toBe(bottom!.x);
	expect(Math.round(bottom!.y - (top!.y + top!.height))).toBe(4);
	expect(tallTile!.height).toBeCloseTo(top!.height * 2 + 4, 0);
	expect(tallTile!.y).toBe(top!.y);

	let four = await boxes("four");
	expect(four).toHaveLength(4);
	expect(four[0]!.y).toBe(four[1]!.y);
	expect(four[2]!.y).toBe(four[3]!.y);
	expect(four[2]!.y).toBeGreaterThan(four[0]!.y);

	let six = message(page, "six").locator('[data-chat-image="tile"]');
	await expect(six).toHaveCount(4);
	await expect(six.nth(3)).toContainText("+2");
	let grid = (await message(page, "six").locator("[data-chat-image-gallery]").boundingBox())!;
	expect(grid.width).toBeLessThanOrEqual(480);
	await expect(six.first()).toHaveCSS("border-radius", "8px");
});

test("the viewer is Slack's: the picture blurred behind it, who sent it, how long ago, where and its name along the top, rotate and zoom at the bottom start, Download alone at the bottom end", async ({ baseURL, join, room, seed }) => {
	let stored = await pictures(baseURL, room, 3);
	await seed("# Weekly review\n", {
		transcript: [{
			id: "sent",
			author: { kind: "member", handle: "Bo_Dev-42" },
			text: `Three of them ![First](${stored[0]!.src}) ![Second](${stored[1]!.src}) ![Third](${
				stored[2]!.src
			})`,
			ts: Math.floor(Date.now() / 1000) - 3 * 3600,
		}],
	});
	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);

	let tiles = message(page, "sent").locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(3);
	await tiles.nth(1).click();
	let open = viewer(page);
	await expect(open.getByRole("status")).toHaveText("2 of 3");
	await expect.poll(async () => await open.boundingBox()).toEqual({
		x: 0,
		y: 0,
		width: 1440,
		height: 900,
	});
	// Behind it, the picture itself, blurred and dimmed, fills the window.
	let backdrop = open.locator(".image-viewer-backdrop img");
	await expect(backdrop).toHaveAttribute("src", /&w=1024$/);
	await expect(backdrop).toHaveCSS("filter", /blur\(64px\) brightness\(0\.55\)/);
	// The sender as written, then when, where and which file.
	await expect(open.locator(".image-viewer-name")).toHaveText("Bo_Dev-42");
	await expect(open.locator(".image-viewer-detail-text")).toHaveText(
		"3 hours ago in Weekly review – Second",
	);
	await expect(open.locator(".image-viewer-face")).toBeVisible();
	let close = (await open.getByRole("button", { name: "Close", exact: true }).boundingBox())!;
	expect(close.y).toBeLessThan(40);
	expect(close.x + close.width).toBeGreaterThan(1400);

	// Along the foot: rotate, then zoom out, the slider and zoom in at the start, Download at the end,
	// and nothing to the right of Download.
	let rotate = (await open.getByRole("button", { name: "Rotate" }).boundingBox())!;
	let out = (await open.getByRole("button", { name: "Zoom out" }).boundingBox())!;
	let slider = (await open.getByRole("slider", { name: "Zoom" }).boundingBox())!;
	let zoomIn = (await open.getByRole("button", { name: "Zoom in" }).boundingBox())!;
	let download = (await open.getByRole("button", { name: "Download image" }).boundingBox())!;
	expect(rotate.x).toBeLessThan(40);
	expect(rotate.x < out.x && out.x < slider.x && slider.x < zoomIn.x).toBe(true);
	expect(zoomIn.x + zoomIn.width).toBeLessThan(400);
	for (let control of [rotate, out, slider, zoomIn, download]) {
		expect(control.y).toBeGreaterThan(820);
	}
	expect(download.x + download.width).toBeGreaterThan(1400);
	// Nothing the viewer draws in Download's row lies to its right.
	let beside = await open.evaluate(
		(element, top) =>
			[...element.querySelectorAll("button, input, a")].filter(control => {
				let box = control.getBoundingClientRect();
				return box.bottom > top && control.getAttribute("aria-label") !== "Download image";
			}).map(control => control.getBoundingClientRect().right),
		download.y,
	);
	expect(Math.max(...beside)).toBeLessThan(download.x);
	let footer = await open.locator("footer").evaluate(element =>
		[...element.querySelectorAll("button, input, a")].map(control =>
			control.getAttribute("aria-label")
		)
	);
	expect(footer).toEqual(["Rotate", "Zoom out", "Zoom", "Zoom in", "Download image"]);

	// The arrows are at the window's edges, halfway down.
	let previous = (await open.getByRole("button", { name: "Previous", exact: true }).boundingBox())!;
	let next = (await open.getByRole("button", { name: "Next", exact: true }).boundingBox())!;
	expect(previous.x).toBeLessThan(40);
	expect(next.x + next.width).toBeGreaterThan(1400);
	expect(previous.y + previous.height / 2).toBeCloseTo(450, -1);
	// It draws a larger copy than the message did, fitted inside the window with a margin.
	let picture = open.getByRole("img", { name: "Second" });
	await expect(picture).toHaveAttribute("src", /&w=1024$/);
	await expect.poll(async () => (await picture.boundingBox())?.width ?? 0).toBeGreaterThan(500);
	let shown = (await picture.boundingBox())!;
	expect(shown.x).toBeGreaterThan(previous.x + previous.width);
	expect(shown.x + shown.width).toBeLessThan(next.x);

	await page.keyboard.press("ArrowRight");
	await expect(open.getByRole("status")).toHaveText("3 of 3");
	await expect(open.locator(".image-viewer-detail-text")).toHaveText(
		"3 hours ago in Weekly review – Third",
	);
	await expect(open.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
	await open.getByRole("button", { name: "Previous", exact: true }).click();
	await expect(open.getByRole("status")).toHaveText("2 of 3");
	// Tab stays inside it, wrapping back to its first control.
	for (let step = 0; step < 10; step++) {
		await page.keyboard.press("Tab");
		await expect.poll(() => open.evaluate(element => element.contains(document.activeElement)))
			.toBe(true);
	}
	await page.keyboard.press("Escape");
	await expect(open).toHaveCount(0);
	await expect(tiles.nth(1)).toBeFocused();
});

test("every control of the viewer is named and says its name on hover", async ({ baseURL, join, room, seed }) => {
	let stored = await pictures(baseURL, room, 2);
	await seed("# Named\n", { transcript: [agent("two", stored)] });
	let page = await join("ana");
	await page.setViewportSize({ width: 1280, height: 900 });
	await openChat(page);
	await message(page, "two").locator('[data-chat-image="tile"]').first().click();
	let open = viewer(page);
	await expect(open.getByRole("img", { name: "Picture 1" })).toBeVisible();
	// A Planner's picture is chopin's.
	await expect(open.locator(".image-viewer-name")).toHaveText("chopin");
	let tooltip = page.locator("[data-icon-tooltip]");
	for (
		let [name, said] of [
			["Close", "Close"],
			["Next", "Next"],
			["Rotate", "Rotate"],
			["Zoom in", "Zoom in"],
			["Download image", "Download image"],
		]
	) {
		await open.getByRole("button", { name: name!, exact: true }).hover();
		await expect(tooltip, name).toHaveText(said!);
		await expect(tooltip, name).toBeVisible();
		// Drawn inside the viewer, above it, not under it on the page.
		expect(await tooltip.evaluate(element => !!element.closest("[data-image-viewer]"))).toBe(true);
	}
	await open.getByRole("slider", { name: "Zoom" }).hover();
	await expect(tooltip).toHaveText("Zoom");
	await expect(tooltip).toBeVisible();
});

test("a picture turns a quarter at a time, and zooms by the slider, −, +, the keys, the wheel and a double-click, then pans under a drag", async ({ baseURL, join, room, seed }) => {
	let stored = await pictures(baseURL, room, 1);
	await seed("# Zoom\n", { transcript: [agent("one", stored)] });
	let page = await join("ana");
	await page.setViewportSize({ width: 1280, height: 900 });
	await openChat(page);
	await message(page, "one").locator("[data-chat-image-frame]").click();
	let open = viewer(page);
	let picture = open.getByRole("img", { name: "Picture 1" });
	await expect(picture).toHaveAttribute("data-shown", "");
	// Its box while zoom and turn ease to where they go, so each is read once it is there.
	let size = async () => {
		let box = (await picture.boundingBox())!;
		return { width: Math.round(box.width), height: Math.round(box.height) };
	};
	let settle = async () => {
		let last = "";
		await expect.poll(async () => {
			let now = JSON.stringify(await size());
			let same = now === last;
			last = now;
			return same;
		}).toBe(true);
	};
	// 600 by 400 fits whole: it is not enlarged, and the slider is at its start.
	await expect.poll(size).toEqual({ width: 600, height: 400 });
	let slider = open.getByRole("slider", { name: "Zoom" });
	await expect(slider).toHaveValue("0");
	await expect(slider).toHaveAttribute("aria-valuetext", "100%");
	await expect(open.getByRole("button", { name: "Zoom out" })).toBeDisabled();

	// Rotate turns it a quarter clockwise: it stands 400 wide and 600 tall.
	await open.getByRole("button", { name: "Rotate" }).click();
	await expect(picture).toHaveAttribute("data-rotation", "90");
	await expect.poll(size).toEqual({ width: 400, height: 600 });
	for (let turn of ["180", "270", "0"]) {
		await open.getByRole("button", { name: "Rotate" }).click();
		await expect(picture).toHaveAttribute("data-rotation", turn);
	}
	await expect.poll(size).toEqual({ width: 600, height: 400 });

	// + zooms in an eighth of the slider; − back.
	await open.getByRole("button", { name: "Zoom in" }).click();
	await expect(slider).toHaveValue("13");
	await expect.poll(async () => (await size()).width).toBeGreaterThan(600);
	await open.getByRole("button", { name: "Zoom out" }).click();
	await expect(slider).toHaveValue("0");
	// The keys: + and =, then 0 back to fitted.
	await page.keyboard.press("+");
	await page.keyboard.press("=");
	await expect(slider).toHaveValue("25");
	await page.keyboard.press("0");
	await expect(slider).toHaveValue("0");
	// The slider itself.
	await slider.fill("100");
	await expect(slider).toHaveAttribute("aria-valuetext", "800%");
	await expect.poll(size).toEqual({ width: 4800, height: 3200 });
	await slider.fill("0");
	await expect.poll(size).toEqual({ width: 600, height: 400 });
	// The wheel zooms where the pointer is.
	let box = (await open.locator(".image-viewer-stage").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -400);
	await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);
	await page.keyboard.press("0");
	// A double-click on the picture toggles fitted and twice its own size.
	await picture.dblclick();
	await expect(slider).toHaveValue("33");
	await expect.poll(size).toEqual({ width: 1200, height: 800 });
	// Twice its size it still fits across, so a drag cannot move it sideways.
	let centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	let drag = async (dx: number, dy: number) => {
		await page.mouse.move(centre.x, centre.y);
		await page.mouse.down();
		await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 6 });
		await page.mouse.up();
	};
	let before = (await picture.boundingBox())!;
	await drag(120, 0);
	expect(Math.round((await picture.boundingBox())!.x)).toBe(Math.round(before.x));
	// At its most, a drag moves it as far as the pointer went, and does not close the viewer.
	await slider.fill("100");
	await expect.poll(size).toEqual({ width: 4800, height: 3200 });
	await settle();
	before = (await picture.boundingBox())!;
	await drag(120, 60);
	await expect(open).toBeVisible();
	let after = (await picture.boundingBox())!;
	expect(Math.round(after.x - before.x)).toBe(120);
	expect(Math.round(after.y - before.y)).toBe(60);
	await page.keyboard.press("0");
	await expect.poll(size).toEqual({ width: 600, height: 400 });
	await picture.dblclick();
	await expect(slider).toHaveValue("33");
	await picture.dblclick();
	await expect(slider).toHaveValue("0");
});

test("Download saves the stored original under its name, and for a file too", async ({ baseURL, join, room, seed }) => {
	let stored = await pictures(baseURL, room, 1);
	await seed("# Save\n", { transcript: [agent("one", stored)] });
	let page = await join("ana");
	await page.setViewportSize({ width: 1280, height: 900 });
	await openChat(page);
	await message(page, "one").locator("[data-chat-image-frame]").click();
	let open = viewer(page);
	let [saved] = await Promise.all([
		page.waitForEvent("download"),
		open.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(saved.suggestedFilename()).toBe("picture-1.png");
	let original = await page.request.get(stored[0]!.src);
	expect(Buffer.compare(
		await original.body(),
		await (await saved.createReadStream()).toArray().then(parts => Buffer.concat(parts)),
	)).toBe(0);
});

test("a message's images and files are one viewer: Previous and Next and the arrow keys step through all of them, a text file is shown as its text, and Download saves it", async ({ join }) => {
	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	let csv = {
		name: "latency-by-day.csv",
		mimeType: "text/csv",
		buffer: Buffer.from("day,p95\nmon,40\n"),
	};
	let second = {
		name: "second.png",
		mimeType: "image/png",
		buffer: png(40, 30, (x, y) => [x * 6, y * 8, 200]),
	};
	await choose(
		page,
		{ name: "first.png", mimeType: "image/png", buffer: png(60, 40) },
		second,
		NOTES,
		csv,
	);
	for (let name of ["first.png", "second.png", "notes.md", "latency-by-day.csv"]) {
		await expect(chip(page, name)).toHaveAttribute("data-state", "done");
	}
	let input = chatInput(chat(page));
	await fillChat(input, "Pictures and the numbers");
	await input.press("Enter");
	let sent = chat(page).locator("[data-chat-message-id]").filter({
		hasText: "Pictures and the numbers",
	});
	let tiles = sent.locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(2);
	await expect(tiles.nth(1)).toHaveAttribute("data-load", "shown");
	let files = sent.getByRole("group", { name: "Files sent with this message" });
	let notes = files.getByRole("button", { name: /^notes\.md/ });

	// Pressing a file opens it where it is among the message's four, as its text.
	await notes.click();
	let open = viewer(page);
	await expect(open.getByRole("status")).toHaveText("3 of 4");
	await expect(open.locator(".image-viewer-detail-text")).toHaveText(/ – notes\.md$/);
	await expect(open.locator("[data-image-viewer-file='text']")).toContainText("# Notes");
	// Rotate and zoom are a picture's: a file has none, and Download stays alone at the end.
	for (let name of ["Rotate", "Zoom in", "Zoom out"]) {
		await expect(open.getByRole("button", { name })).toHaveCount(0);
	}
	await expect(open.getByRole("slider")).toHaveCount(0);
	let [saved] = await Promise.all([
		page.waitForEvent("download"),
		open.getByRole("button", { name: "Download file" }).click(),
	]);
	expect(saved.suggestedFilename()).toBe("notes.md");
	expect(
		await (await saved.createReadStream()).toArray().then(parts => Buffer.concat(parts).toString()),
	).toBe(NOTES.buffer.toString());

	// The keys and the arrows step through all of them, images first as they are drawn, and stop at the ends.
	await page.keyboard.press("ArrowRight");
	await expect(open.getByRole("status")).toHaveText("4 of 4");
	await expect(open.locator("[data-image-viewer-file='text']")).toContainText("mon,40");
	await expect(open.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
	await page.keyboard.press("ArrowRight");
	await expect(open.getByRole("status")).toHaveText("4 of 4");
	await open.getByRole("button", { name: "Previous", exact: true }).click();
	await open.getByRole("button", { name: "Previous", exact: true }).click();
	await expect(open.getByRole("status")).toHaveText("2 of 4");
	await expect(open.getByRole("img", { name: "second.png" })).toBeVisible();
	await expect(open.getByRole("button", { name: "Rotate" })).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await expect(open.getByRole("status")).toHaveText("1 of 4");
	await expect(open.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(open).toHaveCount(0);
	await expect(notes).toBeFocused();
});

test("an image that cannot load is Slack's placeholder in the box the image would have taken, with what happened and its name", async ({ baseURL, join, page, room, seed }) => {
	let [picture] = await pictures(baseURL, room, 1);
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route(/\/images\/b{64}\.png/, async route => {
		await gate;
		await route.fulfill({ status: 404, body: "image not found" });
	});
	await seed("# Placeholders\n", {
		transcript: [
			agent("gone", [{
				src: `/images/${"b".repeat(64)}.png`,
				alt: "Floor plan of the ground floor",
				width: 960,
				height: 480,
				generated: true,
			}]),
			{
				id: "refused",
				author: { kind: "member", handle: "bo" },
				text: "Not one Chat loads ![Sign out](/auth/logout)",
				ts: 1_700_000_100_000,
			},
			agent("fine", [picture!], 1_700_000_200_000),
		],
	});
	await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);

	// While it loads, Slack's quiet box holds the image's shape; when it fails the box says why.
	let gone = message(page, "gone").locator("[data-chat-image]");
	await expect(gone).toHaveAttribute("data-load", "loading");
	let frame = gone.locator(".chat-image-frame");
	// Measured within its message, so the transcript settling its scroll does not count as a move.
	let inMessage = () =>
		frame.evaluate(element => {
			let box = element.getBoundingClientRect();
			let body = element.closest(".chat-message-body")!.getBoundingClientRect();
			return { x: box.x - body.x, y: box.y - body.y, width: box.width, height: box.height };
		});
	let loading = await inMessage();
	expect((loading.width - 2) / (loading.height - 2)).toBeCloseTo(2, 1);
	release();
	await expect(gone).toHaveAttribute("data-load", "broken");
	expect(await inMessage()).toEqual(loading);
	let placeholder = gone.getByRole("img", {
		name: "Couldn’t load image: Floor plan of the ground floor",
		exact: true,
	});
	await expect(placeholder).toBeVisible();
	await expect(placeholder).toContainText("Couldn’t load image");
	// Its name is the line above it, where Slack keeps a file's name.
	await expect(gone.locator(".chat-image-alt")).toHaveText("Floor plan of the ground floor");
	await expect(placeholder.locator("svg")).toHaveCSS("width", "24px");
	// It has nothing to act on, so no toolbar.
	await expect(gone.getByRole("button")).toHaveCount(0);

	let refused = message(page, "refused").locator("[data-chat-image]");
	await expect(refused.getByRole("img", { name: "Image can’t be shown: Sign out", exact: true }))
		.toBeVisible();
	// An image of no stated shape keeps Slack's 360 by 240 box, loading or not.
	let refusedBox = (await refused.locator(".chat-image-frame").boundingBox())!;
	expect([refusedBox.width, refusedBox.height]).toEqual([362, 242]);

	await expect(message(page, "fine").locator("[data-chat-image]")).toHaveAttribute(
		"data-load",
		"shown",
	);
});

test("files are Slack's cards: the type's coloured icon, the name in bold, type and size, and a toolbar of their own", async ({ join }) => {
	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	let csv = {
		name: "latency-by-day.csv",
		mimeType: "text/csv",
		buffer: Buffer.from("day,p95\nmon,40\n"),
	};
	await choose(page, NOTES, csv);
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "done");
	await expect(chip(page, "latency-by-day.csv")).toHaveAttribute("data-state", "done");
	// Staged, each is a short card with its type's icon and its remove button on its corner.
	let staged = chip(page, "latency-by-day.csv");
	await expect(staged).toHaveAttribute("data-kind", "file");
	await expect(staged.locator(".chat-file-icon")).toHaveAttribute("data-file-kind", "spreadsheet");
	let remove = staged.getByRole("button", { name: "Remove latency-by-day.csv" });
	await expect(remove).toHaveCSS("opacity", "0");
	await staged.hover();
	await expect(remove).toHaveCSS("opacity", "1");
	let input = chatInput(chat(page));
	await fillChat(input, "The notes and the numbers");
	await input.press("Enter");

	let sent = chat(page).locator("[data-chat-message-id]").filter({
		hasText: "The notes and the numbers",
	});
	let files = sent.getByRole("group", { name: "Files sent with this message" });
	let cards = files.locator('[data-slot="message-attachment"]');
	await expect(cards).toHaveCount(2);
	let card = cards.nth(1).getByRole("button", { name: /^latency-by-day\.csv/ });
	await expect(card).toContainText("CSV");
	await expect(card).toContainText("15 B");
	await expect(card).toHaveCSS("border-radius", "12px");
	await expect(card).toHaveCSS("border-top-width", "1px");
	let icon = card.locator(".chat-file-icon");
	await expect(icon).toHaveAttribute("data-file-kind", "spreadsheet");
	let iconBox = (await icon.boundingBox())!;
	expect([iconBox.width, iconBox.height]).toEqual([40, 40]);
	await expect(card.getByText("latency-by-day.csv", { exact: true })).toHaveCSS(
		"font-weight",
		"700",
	);
	let gap = (await cards.nth(1).boundingBox())!.y
		- ((await cards.nth(0).boundingBox())!.y + (await cards.nth(0).boundingBox())!.height);
	expect(Math.round(gap)).toBe(8);

	let toolbar = cards.nth(1).getByRole("group", { name: "Actions for latency-by-day.csv" });
	await expect(toolbar).toHaveCSS("opacity", "0");
	await card.hover();
	await expect(toolbar).toHaveCSS("opacity", "1");
	let [saved] = await Promise.all([
		page.waitForEvent("download"),
		toolbar.getByRole("button", { name: "Download latency-by-day.csv" }).click(),
	]);
	expect(saved.suggestedFilename()).toBe("latency-by-day.csv");
});

test("a staged image is a square of its picture, with Slack's ring while it uploads", async ({ join }) => {
	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route("**/attachments?*", async route => {
		await gate;
		await route.continue();
	});
	await choose(page, { name: "shot.png", mimeType: "image/png", buffer: PNG });
	let tile = chip(page, "shot.png");
	await expect(tile).toHaveAttribute("data-state", "uploading");
	await expect(tile).toHaveAttribute("data-kind", "image");
	let box = (await tile.boundingBox())!;
	expect([box.width, box.height]).toEqual([64, 64]);
	await expect(tile.locator(".composer-file-ring")).toBeVisible();
	release();
	await expect(tile).toHaveAttribute("data-state", "done");
	await expect(tile.locator(".composer-file-ring")).toHaveCount(0);
	await expect(tile.locator("img")).toBeVisible();
	await tile.hover();
	await tile.getByRole("button", { name: "Remove shot.png" }).click();
	await expect(strip(page)).toHaveCount(0);
});

test("a 20 MB photo 12000 pixels wide is sent and shown from its thumbnails, never said to be too large", async ({ join }) => {
	test.setTimeout(120_000);
	let seed = 7;
	let noise = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
	let base = png(1500, 1000, () => [noise(), noise(), noise()]);
	let photo = Buffer.from(
		await new Bun.Image(base).resize(12000, 8000, { filter: "nearest" }).jpeg({ quality: 92 })
			.bytes(),
	);
	expect(photo.byteLength).toBeGreaterThan(15 * 1_048_576);

	let page = await join("ana");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	let uploads: number[] = [];
	page.on("request", request => {
		if (request.method() === "POST" && request.url().includes("/attachments?")) {
			uploads.push(request.postDataBuffer()?.byteLength ?? 0);
		}
	});
	await choose(page, { name: "full-res.jpg", mimeType: "image/jpeg", buffer: photo });
	let tile = chip(page, "full-res.jpg");
	await expect(tile).toHaveAttribute("data-state", "done", { timeout: 60_000 });
	expect(uploads).toHaveLength(1);
	expect(uploads[0]).toBeLessThanOrEqual(1_048_576);
	let input = chatInput(chat(page));
	await fillChat(input, "Straight off the camera");
	await input.press("Enter");

	let sent = chat(page).locator("[data-chat-message-id]").filter({
		hasText: "Straight off the camera",
	});
	let figure = sent.locator('[data-chat-image="single"]');
	await expect(figure).toHaveAttribute("data-load", "shown", { timeout: 30_000 });
	let image = figure.locator("img");
	let shown = await image.evaluate(element => ({
		src: (element as HTMLImageElement).currentSrc,
		width: (element as HTMLImageElement).naturalWidth,
	}));
	expect(shown.src).toMatch(/\?w=\d+$/);
	expect(shown.width).toBeLessThanOrEqual(960);
	await expect(sent).not.toContainText("too large");

	await figure.locator("[data-chat-image-frame]").click();
	let open = viewer(page);
	let large = open.getByRole("img", { name: "full-res.jpg" });
	await expect(large).toBeVisible();
	await expect.poll(() => large.evaluate(element => (element as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(shown.width);
	await expect(open.locator(".image-viewer-note")).toHaveText(
		/^Shown smaller\. The original was \d+(\.\d)? MB, 12000 × 8000\.$/,
	);
	let [saved] = await Promise.all([
		page.waitForEvent("download"),
		open.getByRole("button", { name: "Download image" }).click(),
	]);
	// The download is the stored file itself, never a thumbnail.
	let original = (await image.getAttribute("src"))!.replace(/\?w=\d+$/, "");
	let stored = await page.request.get(original);
	expect(Buffer.compare(
		await stored.body(),
		await (await saved.createReadStream()).toArray().then(
			parts => Buffer.concat(parts),
		),
	)).toBe(0);
	expect((await stored.body()).byteLength).toBe(uploads[0]);
});

test("on a phone the images, the grid, the files and the viewer fit the screen", async ({ baseURL, join, room, seed }) => {
	let stored = await pictures(baseURL, room, 3);
	await seed("# Phone\n", {
		transcript: [agent("one", [stored[0]!]), agent("grid", stored, 1_700_000_100_000)],
	});
	let page = await join("ana", PHONE);
	await openChat(page);
	let figure = message(page, "one").locator('[data-chat-image="single"]');
	await expect(figure).toHaveAttribute("data-load", "shown");
	// Each is as wide as its message allows, never wider, and nothing runs off the screen.
	let body = (await message(page, "one").boundingBox())!;

	let frame = (await figure.locator(".chat-image-frame").boundingBox())!;
	expect(frame.x + frame.width).toBeLessThanOrEqual(body.x + body.width + 0.5);
	let grid = (await message(page, "grid").locator("[data-chat-image-gallery]").boundingBox())!;
	expect(grid.x + grid.width).toBeLessThanOrEqual(body.x + body.width + 0.5);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await message(page, "grid").locator('[data-chat-image="tile"]').first().tap();
	let open = viewer(page);
	await expect(open.getByRole("status")).toHaveText("1 of 3");
	await expect.poll(async () => {
		let box = (await open.boundingBox())!;
		return [box.width, box.height];
	}).toEqual([390, 844]);
	// Every control is on the screen and a finger's size, Download still alone at the bottom end.
	for (
		let name of ["Close", "Previous", "Next", "Rotate", "Zoom out", "Zoom in", "Download image"]
	) {
		let control = (await open.getByRole("button", { name, exact: true }).boundingBox())!;
		expect(control.x, name).toBeGreaterThanOrEqual(0);
		expect(control.x + control.width, name).toBeLessThanOrEqual(390);
		expect(control.y + control.height, name).toBeLessThanOrEqual(844);
		expect(control.width, name).toBeGreaterThanOrEqual(44);
	}
	let slider = (await open.getByRole("slider", { name: "Zoom" }).boundingBox())!;
	expect(slider.x + slider.width).toBeLessThanOrEqual(390);
	let download = (await open.getByRole("button", { name: "Download image" }).boundingBox())!;
	expect(download.x + download.width).toBeGreaterThan(340);
	// The picture takes the screen's width.
	let picture = open.getByRole("img", { name: "Picture 1" });
	await expect(picture).toHaveAttribute("data-shown", "");
	await expect.poll(async () => Math.round((await picture.boundingBox())!.width)).toBe(390);

	// Two fingers spread apart zoom it in.
	let centre = await picture.evaluate(element => {
		let box = element.getBoundingClientRect();
		return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	});
	await open.locator(".image-viewer-stage").evaluate((stage, { x, y }) => {
		let fire = (type: string, id: number, dx: number) =>
			stage.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					button: 0,
					clientX: x + dx,
					clientY: y,
					isPrimary: id === 1,
					pointerId: id,
					pointerType: "touch",
				}),
			);
		fire("pointerdown", 1, -40);
		fire("pointerdown", 2, 40);
		for (let step = 1; step <= 5; step++) fire("pointermove", 2, 40 + step * 16);
		fire("pointerup", 1, -40);
		fire("pointerup", 2, 120);
	}, centre);
	await expect.poll(async () => Number(await open.getByRole("slider").inputValue()))
		.toBeGreaterThan(0);

	await open.getByRole("button", { name: "Next", exact: true }).tap();
	await expect(open.getByRole("status")).toHaveText("2 of 3");
});

test("the composer's files keep their place on a phone", async ({ join }) => {
	let page = await join("ana", PHONE);
	await openChat(page);
	await choose(page, { name: "shot.png", mimeType: "image/png", buffer: PNG }, NOTES);
	await expect(chip(page, "shot.png")).toHaveAttribute("data-state", "done");
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "done");
	let box = (await composer(page).boundingBox())!;
	for (let name of ["shot.png", "notes.md"]) {
		let tile = (await chip(page, name).boundingBox())!;
		expect(tile.x + tile.width).toBeLessThanOrEqual(box.x + box.width);
		// On a touch screen the remove button is always there, since nothing hovers.
		await expect(chip(page, name).getByRole("button", { name: `Remove ${name}` })).toHaveCSS(
			"opacity",
			"1",
		);
	}
});
