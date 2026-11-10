import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { createChannel, seedChannelImage, testChannelPath } from "./database";
import { authenticate, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";

const CAP = readFileSync(new URL("./fixtures/the-cap.webp", import.meta.url));
const APP_ICON = readFileSync(new URL("../apps/web/public/icons/icon-192.png", import.meta.url));
const RASTERS = (["avif", "bmp", "ico"] as const).map(extension => ({
	bytes: readFileSync(new URL(`./fixtures/raster-18x6.${extension}`, import.meta.url)),
	extension,
	type: { avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" }[extension],
}));
const WRITE_BACK = readFileSync(new URL("./fixtures/option-write-back.png", import.meta.url));
const WRITE_THROUGH = readFileSync(new URL("./fixtures/option-write-through.png", import.meta.url));
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const NEVER = `/images/${"b".repeat(64)}.png`;

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

function png(width: number, height: number, seed = 0): Uint8Array {
	let rows = new Uint8Array(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		let at = y * (1 + width * 3);
		for (let x = 0; x < width; x++) {
			rows[at + 1 + x * 3] = (x * 255 / width + seed * 40) % 256;
			rows[at + 2 + x * 3] = y * 255 / height;
			rows[at + 3 + x * 3] = 160;
		}
	}
	let header = new Uint8Array(13);
	let view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 2, 0, 0, 0], 8);
	let parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", new Uint8Array()),
	];
	let out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (let part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function port(baseURL: string | undefined): number {
	return Number(new URL(baseURL!).port);
}

function turn(images: Chat.Image[], text = "Here is what I drew."): Chat.Entry[] {
	let ts = 1_700_000_000_000;
	return [
		{
			id: "ask",
			author: { kind: "member", handle: "ana" },
			text: "@chopin draw it",
			to: "planner",
			ts,
		},
		{ id: "drawn", author: { kind: "agent" }, text, ts: ts + 1000, images },
	];
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function figures(page: Page): Locator {
	return chat(page).locator("[data-chat-image]");
}

function layout(figure: Locator) {
	return figure.evaluate(element => {
		let body = element.closest(".chat-message-body")!.getBoundingClientRect();
		let box = element.getBoundingClientRect();
		let stack = element.closest("[data-chat-stack]")!.getBoundingClientRect();
		return {
			offset: box.top - body.top,
			height: box.height,
			width: box.width,
			stack: stack.height,
		};
	});
}

function settled(figure: Locator): Promise<void> {
	return figure.evaluate(async element => {
		await document.fonts.ready;
		let last = Number.NaN;
		let still = 0;
		while (still < 5) {
			await new Promise(requestAnimationFrame);
			let top = element.getBoundingClientRect().top;
			still = top === last ? still + 1 : 0;
			last = top;
		}
	});
}

function lightbox(page: Page): Locator {
	return page.getByRole("dialog", { name: "Image preview", exact: true });
}

async function openChat(page: Page): Promise<void> {
	let tab = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ });
	if (await tab.isVisible()) await tab.click();
	await expect(chat(page)).toBeVisible();
	// A phone's pane slides in from the side; measure it once it has arrived at the left edge.
	await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
}

type Stored = { cap: string; back: string; through: string };

async function store(baseURL: string | undefined, room: string): Promise<Stored> {
	let at = port(baseURL);
	return {
		cap: await seedChannelImage(at, room, CAP, "image/webp"),
		back: await seedChannelImage(at, room, WRITE_BACK, "image/png"),
		through: await seedChannelImage(at, room, WRITE_THROUGH, "image/png"),
	};
}

function three(stored: Stored): Chat.Image[] {
	return [
		{
			src: stored.cap,
			alt: "The cap is a balance of 100.",
			width: 1536,
			height: 1024,
			generated: true,
		},
		{
			src: stored.back,
			alt: "Write-back: write, cache, then database later",
			caption: "Faster, and a crash can lose the last writes.",
			width: 960,
			height: 420,
			generated: true,
		},
		{
			src: stored.through,
			alt: "Write-through: write, cache, database",
			width: 960,
			height: 420,
			generated: true,
		},
	];
}

test("an image holds its shape while it loads, so nothing moves when it arrives", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route("**/images/**", async route => {
		await gate;
		await route.continue();
	});
	await seed("# Cache\n", { transcript: turn([three(stored)[0]!]) });
	await join("ana");

	let figure = figures(page).first();
	let frame = figure.locator("[data-chat-image-frame]");
	await expect(figure).toHaveAttribute("data-load", "loading");
	await expect(figure.locator(".chat-image-placeholder")).toBeVisible();
	await expect(figure.getByText("The cap is a balance of 100.")).toBeVisible();
	await settled(figure);
	let before = (await figure.boundingBox())!;
	let inside = await layout(figure);
	let frameBefore = (await frame.boundingBox())!;
	expect(frameBefore.width / frameBefore.height).toBeCloseTo(1.5, 1);
	expect(frameBefore.width).toBeLessThanOrEqual(384.5);
	await expect(figure.getByRole("button", { name: "Copy image" })).toHaveCount(0);

	release();
	await expect(figure).toHaveAttribute("data-load", "shown");
	await expect.poll(() =>
		figure.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)
	).toBe(1536);
	let after = (await figure.boundingBox())!;
	expect(after.y).toBe(before.y);
	expect(after.height).toBe(before.height);
	expect(after.width).toBe(before.width);
	expect(await layout(figure)).toEqual(inside);
	await expect(figure.locator(".chat-image-placeholder")).toHaveCount(0);
	await expect(figure.locator("img")).toHaveCSS("opacity", "1");
});

test("a tall image is fitted to the height a message allows, whatever its shape", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let tall = await seedChannelImage(port(baseURL), room, png(300, 900), "image/png");
	await seed("# Tall\n", {
		transcript: turn([{ src: tall, alt: "A tall drawing", width: 300, height: 900 }]),
	});
	await join("ana");

	let frame = figures(page).first().locator("[data-chat-image-frame]");
	await expect(figures(page).first()).toHaveAttribute("data-load", "shown");
	let box = (await frame.boundingBox())!;
	expect(box.height).toBeCloseTo(448, 0);
	expect(box.width / box.height).toBeCloseTo(1 / 3, 2);
});

test("an image's alt text and caption are always on the page, and a missing alt is named", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Words\n", {
		transcript: [
			...turn([three(stored)[1]!], "One with a caption."),
			{
				id: "bare",
				author: { kind: "agent" },
				text: "",
				ts: 1_700_000_100_000,
				images: [{ src: stored.cap, width: 1536, height: 1024, generated: true }],
			},
			{
				id: "plain",
				author: { kind: "member", handle: "bo" },
				text: `A person's own ![](${stored.through})`,
				ts: 1_700_000_200_000,
			},
		],
	});
	await join("ana");

	let [captioned, bare, plain] = [figures(page).nth(0), figures(page).nth(1), figures(page).nth(2)];
	await expect(captioned.getByText("Write-back: write, cache, then database later")).toBeVisible();
	await expect(captioned.getByText("Faster, and a crash can lose the last writes.")).toBeVisible();
	await expect(captioned.getByText("Generated", { exact: true })).toBeVisible();
	await expect(bare.getByText("Generated image", { exact: true })).toBeVisible();
	await expect(bare.locator("img")).toHaveAttribute("alt", "Generated image");
	await expect(plain.getByText("Image", { exact: true })).toBeVisible();
	await expect(plain.locator("img")).toHaveAttribute("alt", "Image");
	await expect(plain.getByText("Generated")).toHaveCount(0);
});

test("an image that cannot be loaded says so in the place it would have been", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Broken\n", {
		transcript: [
			...turn([{
				src: NEVER,
				alt: "A picture that is gone",
				width: 960,
				height: 420,
				generated: true,
			}]),
			{
				id: "fine",
				author: { kind: "agent" },
				text: "This one is fine.",
				ts: 1_700_000_100_000,
				images: [three(stored)[2]!],
			},
		],
	});
	await join("ana");

	let broken = figures(page).first();
	await expect(broken).toHaveAttribute("data-load", "broken");
	await expect(broken.getByText("Couldn’t load image")).toBeVisible();
	await expect(broken.getByText("A picture that is gone")).toBeVisible();
	let frame = (await broken.locator("[data-chat-image-frame]").boundingBox())!;
	expect(frame.width / frame.height).toBeCloseTo(960 / 420, 1);
	await broken.hover();
	for (let name of ["Open image", "Copy image", "Download image"]) {
		await expect(broken.getByRole("button", { name })).toHaveCount(0);
	}
	await expect(figures(page).nth(1)).toHaveAttribute("data-load", "shown");
});

test("several images of one turn are a compact gallery with their words under each tile", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Gallery\n", { transcript: turn(three(stored)) });
	await join("ana");

	let tiles = chat(page).locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(3);
	await expect(chat(page).locator('[data-chat-image="single"]')).toHaveCount(0);
	for (let [index, tile] of (await tiles.all()).entries()) {
		await expect(tile).toHaveAttribute("data-load", "shown");
		let box = (await tile.locator("[data-chat-image-frame]").boundingBox())!;
		let { height, width } = three(stored)[index]!;
		expect(box.width / box.height).toBeCloseTo(width / height, 1);
	}
	await expect(tiles.nth(0).getByText("The cap is a balance of 100.")).toBeVisible();
	await expect(tiles.nth(1).getByText("Faster, and a crash can lose the last writes."))
		.toBeVisible();
	await expect(tiles.nth(2).getByText("Write-through: write, cache, database")).toBeVisible();
	let first = (await tiles.nth(0).boundingBox())!;
	let third = (await tiles.nth(2).boundingBox())!;
	expect(third.y).toBe(first.y);
});

test("a gallery tile has its image's own shape before the image arrives, and the shape the image turns out to have", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let at = port(baseURL);
	let sizes = [[300, 200], [400, 100], [90, 270]] as const;
	let images: Chat.Image[] = [];
	for (let [width, height] of sizes) {
		images.push({
			src: await seedChannelImage(at, room, png(width, height), "image/png"),
			alt: `${width} by ${height}`,
			width,
			height,
			generated: true,
		});
	}
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route("**/images/**", async route => {
		await gate;
		await route.continue();
	});
	await seed("# Shapes\n", { transcript: turn(images) });
	await join("ana");

	let tiles = chat(page).locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(3);
	let frames = tiles.locator("[data-chat-image-frame]");
	for (let tile of await tiles.all()) await expect(tile).toHaveAttribute("data-load", "loading");
	await settled(tiles.first());
	let before = await frames.evaluateAll(all =>
		all.map(frame => frame.getBoundingClientRect().toJSON())
	);
	for (let [index, [width, height]] of sizes.entries()) {
		let box = before[index]!;
		expect(Math.abs(box.width / box.height / (width / height) - 1), `${width} by ${height}`)
			.toBeLessThan(0.01);
	}

	release();
	for (let tile of await tiles.all()) await expect(tile).toHaveAttribute("data-load", "shown");
	let after = await frames.evaluateAll(all =>
		all.map(frame => frame.getBoundingClientRect().toJSON())
	);
	expect(after).toEqual(before);
	for (let [index, tile] of (await tiles.all()).entries()) {
		let natural = await tile.locator("img").evaluate(image => ({
			height: (image as HTMLImageElement).naturalHeight,
			width: (image as HTMLImageElement).naturalWidth,
		}));
		let box = after[index]!;
		expect(
			Math.abs(box.width / box.height / (natural.width / natural.height) - 1),
			`${natural.width} by ${natural.height}`,
		).toBeLessThan(0.01);
	}
});

test("more than six images show six tiles, and the lightbox reaches all of them", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let at = port(baseURL);
	let images: Chat.Image[] = [];
	for (let index = 0; index < 8; index++) {
		images.push({
			src: await seedChannelImage(at, room, png(160 + index, 120), "image/png"),
			alt: `Variant ${index + 1}`,
			width: 160 + index,
			height: 120,
			generated: true,
		});
	}
	await seed("# Many\n", { transcript: turn(images) });
	await join("ana");

	let tiles = chat(page).locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(6);
	await expect(tiles.nth(5).locator(".chat-image-more")).toHaveText("+2");
	await tiles.nth(5).locator("[data-chat-image-frame]").click({ position: { x: 20, y: 60 } });
	let box = lightbox(page);
	await expect(box).toBeVisible();
	await expect(box.getByRole("img", { name: "Variant 6" })).toBeVisible();
	await expect(box.getByRole("status")).toHaveText("Image 6 of 8");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect(box.getByRole("img", { name: "Variant 8" })).toBeVisible();
	await expect(box.getByRole("button", { name: "Next image" })).toBeDisabled();
});

test("the lightbox opens, steps and closes by mouse", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Mouse\n", { transcript: turn(three(stored)) });
	await join("ana");

	let tiles = chat(page).locator('[data-chat-image="tile"]');
	await expect(tiles.nth(1)).toHaveAttribute("data-load", "shown");
	await tiles.nth(1).locator("[data-chat-image-frame]").click({ position: { x: 20, y: 20 } });
	let box = lightbox(page);
	await expect(box).toBeVisible();
	await expect(box.getByRole("img", { name: "Write-back: write, cache, then database later" }))
		.toBeVisible();
	await expect(box.getByText("Faster, and a crash can lose the last writes.")).toBeVisible();
	await expect(box.getByText("Generated", { exact: true })).toBeVisible();
	await expect(box.getByRole("status")).toHaveText("Image 2 of 3");

	await box.getByRole("button", { name: "Previous image" }).click();
	await expect(box.getByRole("img", { name: "The cap is a balance of 100." })).toBeVisible();
	await expect(box.getByRole("button", { name: "Previous image" })).toBeDisabled();
	await box.getByRole("button", { name: "Next image" }).click();
	await box.getByRole("button", { name: "Next image" }).click();
	await expect(box.getByRole("img", { name: "Write-through: write, cache, database" }))
		.toBeVisible();
	await expect(box.getByRole("button", { name: "Next image" })).toBeDisabled();
	await box.getByRole("button", { name: "Zoom in" }).click();
	await expect(box.getByRole("button", { name: "Zoom out" })).toBeVisible();
	await box.getByRole("button", { name: "Previous image" }).click();
	await expect(box.getByRole("button", { name: "Zoom in" })).toBeVisible();

	await box.getByRole("button", { name: "Close image preview" }).click();
	await expect(box).toHaveCount(0);

	await tiles.nth(0).locator("[data-chat-image-frame]").click({ position: { x: 20, y: 20 } });
	await expect(box).toBeVisible();
	await box.click({ position: { x: 6, y: 300 } });
	await expect(box).toHaveCount(0);
});

test("the lightbox opens, steps, traps focus and gives it back by keyboard", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Keys\n", { transcript: turn(three(stored)) });
	await join("ana");

	let tiles = chat(page).locator('[data-chat-image="tile"]');
	await expect(tiles.nth(1)).toHaveAttribute("data-load", "shown");
	let opener = tiles.nth(1).getByRole("button", { name: "Open image", exact: true });
	await opener.focus();
	await page.keyboard.press("Enter");
	let box = lightbox(page);
	await expect(box).toBeVisible();
	await expect(box.getByRole("button", { name: "Close image preview" })).toBeFocused();
	await expect(box.getByRole("status")).toHaveText("Image 2 of 3");

	await page.keyboard.press("ArrowRight");
	await expect(box.getByRole("status")).toHaveText("Image 3 of 3");
	await page.keyboard.press("ArrowRight");
	await expect(box.getByRole("status")).toHaveText("Image 3 of 3");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect(box.getByRole("status")).toHaveText("Image 1 of 3");
	await page.keyboard.press("ArrowLeft");
	await expect(box.getByRole("status")).toHaveText("Image 1 of 3");

	let inside = () =>
		page.evaluate(() => !!document.activeElement?.closest("dialog.plan-image-lightbox"));
	for (let step = 0; step < 7; step++) {
		await page.keyboard.press("Tab");
		expect(await inside()).toBe(true);
	}
	for (let step = 0; step < 7; step++) {
		await page.keyboard.press("Shift+Tab");
		expect(await inside()).toBe(true);
	}

	await page.keyboard.press("Escape");
	await expect(box).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test("an image can be downloaded under the name of what it shows, and copied", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(baseURL!).origin,
	});
	let stored = await store(baseURL, room);
	await seed("# Take it\n", { transcript: turn([three(stored)[0]!]) });
	await join("ana");

	let figure = figures(page).first();
	await expect(figure).toHaveAttribute("data-load", "shown");
	await figure.hover();
	await expect(figure.locator(".chat-image-actions")).toHaveCSS("opacity", "1");
	let [download] = await Promise.all([
		page.waitForEvent("download"),
		figure.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(download.suggestedFilename()).toBe("the-cap-is-a-balance-of-100.webp");
	expect(readFileSync((await download.path())!).equals(CAP)).toBe(true);
	await expect(lightbox(page)).toHaveCount(0);

	await figure.getByRole("button", { name: "Copy image" }).click();
	await expect(figure.getByRole("button", { name: "Copied image" })).toBeVisible();
	// A browser lets a page copy a PNG: the stored WebP is redrawn as one.
	let signature = await page.evaluate(async () => {
		let [item] = await navigator.clipboard.read();
		let blob = await item!.getType("image/png");
		return Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 4));
	});
	expect(signature).toEqual([0x89, 0x50, 0x4e, 0x47]);
	await expect(figure.getByRole("button", { name: "Copy image" })).toBeVisible();
	await expect(lightbox(page)).toHaveCount(0);
});

test("the lightbox carries open, copy and download for what it shows", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Out\n", { transcript: turn(three(stored)) });
	await join("ana");

	let tiles = chat(page).locator('[data-chat-image="tile"]');
	await expect(tiles.nth(0)).toHaveAttribute("data-load", "shown");
	await tiles.nth(0).locator("[data-chat-image-frame]").click({ position: { x: 20, y: 40 } });
	let box = lightbox(page);
	let [download] = await Promise.all([
		page.waitForEvent("download"),
		box.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(download.suggestedFilename()).toBe("the-cap-is-a-balance-of-100.webp");
	await box.getByRole("button", { name: "Next image" }).click();
	await expect(box.getByRole("button", { name: "Copy image" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(box).toHaveCount(0);
});

test("an image from another site can be opened, copied and saved where its host allows it, and says so where it does not", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(baseURL!).origin,
	});
	await page.route("https://example.invalid/open/**", route =>
		route.fulfill({
			contentType: "image/png",
			headers: { "access-control-allow-origin": "*" },
			body: Buffer.from(png(40, 30)),
		}));
	// Playwright adds CORS headers to a fulfilled response, so a host's refusal is a failed fetch.
	await page.route(
		"https://example.invalid/closed/**",
		route =>
			route.request().resourceType() === "fetch"
				? route.abort()
				: route.fulfill({ contentType: "image/png", body: Buffer.from(png(40, 30)) }),
	);
	await seed("# Out\n", {
		transcript: [
			{
				id: "far",
				author: { kind: "member", handle: "bo" },
				text:
					"![far away](https://example.invalid/open/far.png)\n\n![shut away](https://example.invalid/closed/near.png)",
				ts: 1_700_000_900_000,
			},
		],
	});
	await join("ana");

	let [open, closed] = [figures(page).nth(0), figures(page).nth(1)];
	await expect(open).toHaveAttribute("data-load", "shown");
	await expect(closed).toHaveAttribute("data-load", "shown");

	await open.hover();
	for (let name of ["Open image", "Copy image", "Download image"]) {
		await expect(open.getByRole("button", { name, exact: true })).toHaveCount(1);
	}
	await expect(open.getByRole("link", { name: "Open image in a new tab" })).toHaveAttribute(
		"href",
		"https://example.invalid/open/far.png",
	);
	let [download] = await Promise.all([
		page.waitForEvent("download"),
		open.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(download.suggestedFilename()).toBe("far-away.png");
	await open.getByRole("button", { name: "Copy image" }).click();
	await expect(open.getByRole("button", { name: "Copied image" })).toBeVisible();

	// Its host does not allow a page to read it, so a copy and a save say they could not.
	await closed.hover();
	await closed.getByRole("button", { name: "Copy image" }).click();
	await expect(closed.getByRole("button", { name: "Couldn’t copy image" })).toBeVisible();
	await closed.getByRole("button", { name: "Download image" }).click();
	await expect(closed.getByRole("button", { name: "Couldn’t download image" })).toBeVisible();
	await expect(closed.getByRole("link", { name: "Open image in a new tab" })).toHaveAttribute(
		"href",
		"https://example.invalid/closed/near.png",
	);

	await closed.getByRole("button", { name: "Open image", exact: true }).click();
	let box = lightbox(page);
	await expect(box.getByRole("status")).toHaveText("Image 2 of 2");
	for (let name of ["Copy image", "Download image"]) {
		await expect(box.getByRole("button", { name })).toBeVisible();
	}
	await expect(box.getByRole("link", { name: "Open image in a new tab" })).toHaveAttribute(
		"href",
		"https://example.invalid/closed/near.png",
	);
});

test("a person without access to the document is refused its images", async ({ baseURL, browser, join, page, room, seed }) => {
	let stored = await store(baseURL, room);
	await seed("# Private\n", { transcript: turn(three(stored)) });
	await join("ana");
	let url = `${stored.cap}?document=${encodeURIComponent(room)}`;

	let reader = await page.request.get(url);
	expect(reader.status()).toBe(200);
	expect(reader.headers()["content-type"]).toBe("image/webp");
	expect(reader.headers()["x-content-type-options"]).toBe("nosniff");

	let stranger = await browser.newContext({ baseURL });
	try {
		let strangerPage = await stranger.newPage();
		await authenticate(strangerPage, `score-outsider-${crypto.randomUUID()}`, baseURL!);
		let refused = await stranger.request.get(url);
		expect(refused.status()).toBe(404);
		expect(await refused.text()).toBe("image not found");
		await strangerPage.goto(testChannelPath(room));
		await expect(strangerPage.locator("[data-chat-image]")).toHaveCount(0);
	} finally {
		await stranger.close();
	}
	let anonymous = await fetch(new URL(url, baseURL));
	expect(anonymous.status).toBe(404);
});

test("every image a person writes in Markdown is drawn where they wrote it", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	let dot = `data:image/png;base64,${Buffer.from(png(6, 4)).toString("base64")}`;
	let requested: string[] = [];
	await page.route("https://example.invalid/**", async route => {
		requested.push(`${route.request().url()} referer=${route.request().headers()["referer"]}`);
		await route.fulfill({ contentType: "image/png", body: Buffer.from(png(40, 30)) });
	});
	await page.route("**/auth/logout", async route => {
		requested.push(route.request().url());
		await route.abort();
	});
	await seed("# Written\n", {
		transcript: [{
			id: "written",
			author: { kind: "member", handle: "bo" },
			text: [
				"First ![the cap](" + stored.cap + ") then ![a remote one](https://example.invalid/a.png).",
				"",
				"Again ![the cap](" + stored.cap
				+ ") and ![a request](/auth/logout) and ![](images/x.png)"
				+ ` and ![a dot](${dot}).`,
			].join("\n"),
			ts: 1_700_000_000_000,
		}],
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(6);
	await expect(all.nth(0).locator("img")).toHaveAttribute("alt", "the cap");
	await expect(all.nth(1).locator("img")).toHaveAttribute("alt", "a remote one");
	await expect(all.nth(2).locator("img")).toHaveAttribute("alt", "the cap");
	await expect(all.nth(0)).toHaveAttribute("data-load", "shown");
	await expect(all.nth(1)).toHaveAttribute("data-load", "shown");
	await expect(all.nth(3).getByText("Image can’t be shown")).toBeVisible();
	await expect(all.nth(3).getByText("a request")).toBeVisible();
	await expect(all.nth(4)).toHaveAttribute("data-load", "broken");
	await expect(all.nth(4).getByText("Couldn’t load image")).toBeVisible();
	await expect(all.nth(4).getByText("Image", { exact: true })).toBeVisible();
	expect(requested.filter(item => item.includes("/auth/logout"))).toEqual([]);
	await expect(all.nth(5)).toHaveAttribute("data-load", "shown");
	await expect(all.nth(5).locator("img")).toHaveAttribute("src", dot);
	await all.nth(5).hover();
	for (let name of ["Open image", "Copy image", "Download image"]) {
		await expect(all.nth(5).getByRole("button", { name, exact: true })).toHaveCount(1);
	}
	expect(requested.filter(item => item.includes("/a.png"))).toEqual([
		"https://example.invalid/a.png referer=undefined",
	]);

	await all.nth(1).getByRole("button", { name: "Open image", exact: true }).click();
	let box = lightbox(page);
	await expect(box.getByRole("status")).toHaveText("Image 2 of 4");
	await expect(box.getByRole("img", { name: "a remote one" })).toBeVisible();
	for (let name of ["Copy image", "Download image"]) {
		await expect(all.nth(1).getByRole("button", { name })).toHaveCount(1);
	}
	await expect(all.nth(1).getByRole("link", { name: "Open image in a new tab" })).toHaveCount(1);
});

type Sent = { cookie: string | undefined; path: string; search: string; type: string };

function watch(page: Page, prefixes: string[]): { sent: Sent[]; settle: () => Promise<void> } {
	let sent: Sent[] = [];
	let pending: Promise<void>[] = [];
	page.on("request", request => {
		let { pathname, search } = new URL(request.url());
		if (!prefixes.some(prefix => pathname.startsWith(prefix))) return;
		pending.push(
			request.allHeaders().then(headers => {
				sent.push({
					cookie: headers["cookie"],
					path: pathname,
					search,
					type: request.resourceType(),
				});
			}),
		);
	});
	return { sent, settle: () => Promise.all(pending).then(() => undefined) };
}

test("an image on this site that is not an upload is drawn, read without the reader's session", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(baseURL!).origin,
	});
	let { sent, settle } = watch(page, ["/icons/"]);
	await seed("# Local\n", {
		transcript: [{
			id: "local",
			author: { kind: "member", handle: "bo" },
			text: [
				"![the app icon](/icons/icon-192.png)",
				"",
				`![from the root](icons/icon-192.png) then ![a dot path](./icons/icon-192.png?size=big) and ![absolute](${baseURL}/icons/icon-192.png)`,
			].join("\n"),
			ts: 1_700_000_000_000,
		}],
	});
	await join("ana");
	expect((await page.context().cookies()).some(cookie => cookie.name === "chopin_session")).toBe(
		true,
	);

	let all = figures(page);
	await expect(all).toHaveCount(4);
	for (let [index, alt] of ["the app icon", "from the root", "a dot path", "absolute"].entries()) {
		await expect(all.nth(index)).toHaveAttribute("data-load", "shown");
		await expect(all.nth(index).locator("img")).toHaveAttribute("alt", alt);
		await expect(all.nth(index).getByText(alt, { exact: true })).toBeVisible();
		expect(
			await all.nth(index).locator("img").evaluate(async node => {
				let image = node as HTMLImageElement;
				let drawn = new Uint8Array(await (await fetch(image.src)).arrayBuffer());
				return { drawn: [...drawn], src: image.src.split(":")[0], width: image.naturalWidth };
			}).then(({ drawn, src, width }) => ({
				same: Buffer.from(drawn).equals(APP_ICON),
				src,
				width,
			})),
			alt,
		).toEqual({ same: true, src: "blob", width: 192 });
	}

	await settle();
	expect(sent.map(item => item.path)).toEqual(Array(4).fill("/icons/icon-192.png"));
	for (let item of sent) {
		expect(item.type).toBe("fetch");
		expect(item.cookie).toBeUndefined();
	}

	await all.nth(0).hover();
	for (let name of ["Open image", "Copy image", "Download image"]) {
		await expect(all.nth(0).getByRole("button", { name, exact: true })).toHaveCount(1);
	}
	await expect(all.nth(0).getByRole("link", { name: "Open image in a new tab" })).toHaveCount(0);
	let [download] = await Promise.all([
		page.waitForEvent("download"),
		all.nth(0).getByRole("button", { name: "Download image" }).click(),
	]);
	expect(download.suggestedFilename()).toBe("the-app-icon.png");
	await all.nth(0).getByRole("button", { name: "Copy image" }).click();
	await expect(all.nth(0).getByRole("button", { name: "Copied image" })).toBeVisible();

	await all.nth(2).getByRole("button", { name: "Open image", exact: true }).click();
	let box = lightbox(page);
	await expect(box.getByRole("status")).toHaveText("Image 3 of 4");
	await expect(box.getByRole("img", { name: "a dot path" })).toBeVisible();
	for (let name of ["Copy image", "Download image"]) {
		await expect(box.getByRole("button", { name })).toBeVisible();
	}
	await page.keyboard.press("ArrowRight");
	await expect(box.getByRole("img", { name: "absolute" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(box).toHaveCount(0);
});

test("a raster image of any format is drawn, from this site or written into the message, and SVG written into it is not", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	for (let { bytes, extension, type } of RASTERS) {
		await page.route(
			`**/inline/raster.${extension}`,
			route => route.fulfill({ body: bytes, contentType: type }),
		);
	}
	let svg = "data:image/svg+xml;base64,"
		+ Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgRan = 1"><script>window.__svgRan = 1</script></svg>',
		).toString("base64");
	let { sent, settle } = watch(page, ["/inline/"]);
	await seed("# Rasters\n", {
		transcript: [{
			id: "rasters",
			author: { kind: "member", handle: "bo" },
			text: [
				...RASTERS.map(({ extension }) =>
					`![on this site, ${extension}](/inline/raster.${extension})`
				),
				...RASTERS.map(({ bytes, extension, type }) =>
					`![written, ${extension}](data:${type};base64,${bytes.toString("base64")})`
				),
				`![written, svg](${svg})`,
			].join("\n\n"),
			ts: 1_700_000_000_000,
		}],
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(7);
	for (let [index, { extension }] of RASTERS.entries()) {
		for (
			let [offset, scheme, label] of [[0, "blob", "on this site"], [3, "data", "written"]] as const
		) {
			let figure = all.nth(offset + index);
			await expect(figure).toHaveAttribute("data-load", "shown");
			await expect(figure.locator("img")).toHaveAttribute("alt", `${label}, ${extension}`);
			expect(
				await figure.locator("img").evaluate(node => ({
					scheme: (node as HTMLImageElement).src.split(":")[0],
					width: (node as HTMLImageElement).naturalWidth,
				})),
				`${label}, ${extension}`,
			).toEqual({ scheme, width: 18 });
		}
	}
	await expect(all.nth(6).getByText("Image can’t be shown")).toBeVisible();
	await expect(all.nth(6).getByText("written, svg", { exact: true })).toBeVisible();
	await expect(all.nth(6).locator("img")).toHaveCount(0);
	await settle();
	expect(sent.map(item => item.path).sort()).toEqual(
		RASTERS.map(({ extension }) => `/inline/raster.${extension}`).sort(),
	);
	for (let item of sent) expect(item.cookie, item.path).toBeUndefined();
	expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
});

const WRITTEN_TYPES = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	ico: "image/x-icon",
	jpg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
} as const;

function fixture(name: string): Buffer {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

function written(
	name: string,
	type: string = WRITTEN_TYPES[name.split(".").pop() as keyof typeof WRITTEN_TYPES],
): string {
	return `data:${type};base64,${fixture(name).toString("base64")}`;
}

async function holdDecodingOfWrittenImages(page: Page) {
	await page.addInitScript(() => {
		let held: HTMLImageElement[] = [];
		let open = false;
		document.addEventListener("load", event => {
			let image = event.target;
			if (open || !(image instanceof HTMLImageElement) || !image.src.startsWith("data:")) return;
			event.stopImmediatePropagation();
			held.push(image);
		}, true);
		let firstSeen = new Map<string, { load: string | null; ratio: number }>();
		new MutationObserver(() => {
			for (let figure of document.querySelectorAll("[data-chat-image]")) {
				let key = figure.querySelector("figcaption")?.textContent ?? "";
				let frame = figure.querySelector("[data-chat-image-frame]");
				if (!frame || firstSeen.has(key)) continue;
				let box = frame.getBoundingClientRect();
				firstSeen.set(key, {
					load: figure.getAttribute("data-load"),
					ratio: box.width / box.height,
				});
			}
		}).observe(document, { childList: true, subtree: true });
		Object.assign(window, {
			__firstSeen: () => Object.fromEntries(firstSeen),
			__release: () => {
				open = true;
				for (let image of held.splice(0)) image.dispatchEvent(new Event("load"));
			},
		});
	});
	return {
		firstSeen: () =>
			page.evaluate(() =>
				(window as any).__firstSeen() as Record<string, { load: string | null; ratio: number }>
			),
		release: () => page.evaluate(() => (window as any).__release()),
	};
}

async function naturalSize(figure: Locator) {
	return figure.locator("img").evaluate(image => ({
		height: (image as HTMLImageElement).naturalHeight,
		width: (image as HTMLImageElement).naturalWidth,
	}));
}

async function figureBox(figure: Locator) {
	let frame = (await figure.locator("[data-chat-image-frame]").boundingBox())!;
	return { ...(await layout(figure)), frame: { height: frame.height, width: frame.width } };
}

function oneMessageEachLine(text: string): Chat.Entry[] {
	return text.split("\n").map((line, index): Chat.Entry => ({
		id: `written-${index}`,
		author: { kind: "member", handle: "bo" },
		text: line,
		ts: 1_700_000_000_000 + index * 1000,
	}));
}

test("an image written into a message holds the shape its own bytes give from the first paint, whatever its format and way up, so nothing moves when it is decoded", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let decoding = await holdDecodingOfWrittenImages(page);
	let percent = [...fixture("raster-18x6.png")].map(byte =>
		`%${byte.toString(16).padStart(2, "0")}`
	).join("");
	let cases: Array<{ name: string; src: string; ratio: number }> = [];
	for (let extension of Object.keys(WRITTEN_TYPES)) {
		cases.push(
			{ name: `${extension}, landscape`, src: written(`raster-18x6.${extension}`), ratio: 3 },
			{ name: `${extension}, portrait`, src: written(`raster-6x18.${extension}`), ratio: 1 / 3 },
		);
	}
	cases.push(
		{
			name: "jpg, turned by its EXIF orientation",
			src: written("raster-18x6-turned.jpg"),
			ratio: 1 / 3,
		},
		{ name: "png, turned by its eXIf chunk", src: written("raster-18x6-turned.png"), ratio: 1 / 3 },
		{ name: "avif, turned by its rotation", src: written("raster-18x6-turned.avif"), ratio: 1 / 3 },
		{ name: "ico, of two sizes", src: written("raster-18x6-two-sizes.ico"), ratio: 3 },
		{ name: "jpg named as a png", src: written("raster-18x6.jpg", "image/png"), ratio: 3 },
		{
			name: "jpg with two EXIF blocks, the second turning it",
			src: written("raster-18x6-two-exif.jpg"),
			ratio: 3,
		},
		{
			name: "jpg whose orientation is not a SHORT",
			src: written("raster-18x6-exif-long.jpg"),
			ratio: 3,
		},
		{
			name: "png whose orientation is not a SHORT",
			src: written("raster-18x6-exif-long.png"),
			ratio: 3,
		},
		{
			name: "png with a charset parameter",
			src: written("raster-18x6.png").replace("data:image/png;", "data:image/png;charset=utf-8;"),
			ratio: 3,
		},
		{ name: "png with percent escapes", src: `data:image/png,${percent}`, ratio: 3 },
	);
	await seed("# Written\n", {
		transcript: oneMessageEachLine(cases.map(({ name, src }) => `![${name}](${src})`).join("\n")),
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(cases.length);
	for (let figure of await all.all()) await figure.scrollIntoViewIfNeeded();
	await expect.poll(() =>
		all.locator("img").evaluateAll(images =>
			images.filter(image => !(image as HTMLImageElement).naturalWidth).map(image =>
				(image as HTMLImageElement).alt
			)
		)
	).toEqual([]);
	for (let figure of await all.all()) await expect(figure).toHaveAttribute("data-load", "loading");
	await settled(all.last());

	let before = await Promise.all((await all.all()).map(figureBox));
	let firstSeen = await decoding.firstSeen();
	for (let [index, { name, ratio, src }] of cases.entries()) {
		let figure = all.nth(index);
		let natural = await naturalSize(figure);
		let frame = before[index]!.frame;
		expect(natural.width / natural.height, name).toBeCloseTo(ratio, 5);
		expect(Math.abs(frame.width / frame.height / ratio - 1), `${name} while it loads`).toBeLessThan(
			0.01,
		);
		expect(firstSeen[name]?.load, name).toBe("loading");
		expect(Math.abs(firstSeen[name]!.ratio / ratio - 1), `${name} at the first paint`).toBeLessThan(
			0.01,
		);
		await expect(figure.locator(".chat-image-placeholder")).toBeVisible();
		await expect(figure.locator("img")).toHaveAttribute("src", src);
		await expect(figure.locator("img")).toHaveAttribute("alt", name);
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
	}

	await decoding.release();
	for (let figure of await all.all()) await expect(figure).toHaveAttribute("data-load", "shown");
	await settled(all.last());
	let after = await Promise.all((await all.all()).map(figureBox));
	expect(after).toEqual(before);
	for (let [index, { name, ratio }] of cases.entries()) {
		let natural = await naturalSize(all.nth(index));
		expect(natural.width / natural.height, name).toBeCloseTo(ratio, 5);
		expect(Math.abs(after[index]!.frame.width / after[index]!.frame.height / ratio - 1), name)
			.toBeLessThan(0.01);
	}
});

test("an image written into a message whose shape is not read from its bytes keeps the fixed frame, and is drawn or reported as before", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let decoding = await holdDecodingOfWrittenImages(page);
	let cases = [
		{ name: "not a PNG", src: "data:image/png;base64,AAAA", fixed: true, broken: true },
		{ name: "no payload", src: "data:image/png;base64,", fixed: true, broken: true },
		{ name: "cut short", src: "data:image/webp,RIFF", fixed: true, broken: true },
		{
			name: "icon of two shapes",
			src: written("raster-18x6-and-6x18.ico"),
			fixed: true,
			broken: false,
		},
		{
			name: "avif cropped by its clean aperture",
			src: written("raster-18x6-cropped.avif"),
			fixed: true,
			broken: false,
		},
		{
			name: "png that cannot be decoded",
			src: `data:image/png;base64,${
				Buffer.from(fixture("raster-18x6.png")).fill(0, 29, 33).toString("base64")
			}`,
			fixed: false,
			broken: true,
		},
		{
			name: "jpg whose EXIF density Chromium applies",
			src: written("raster-18x6-density.jpg"),
			fixed: true,
			broken: false,
		},
	];
	await seed("# Fallback\n", {
		transcript: oneMessageEachLine(cases.map(({ name, src }) => `![${name}](${src})`).join("\n")),
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(cases.length);
	await settled(all.last());
	let firstSeen = await decoding.firstSeen();
	for (let [index, { broken, fixed, name, src }] of cases.entries()) {
		let figure = all.nth(index);
		let ratio = firstSeen[name]!.ratio;
		expect(firstSeen[name]!.load, name).toBe("loading");
		expect(Math.abs(ratio / (fixed ? 4 / 3 : 3) - 1), `${name} at the first paint`).toBeLessThan(
			0.01,
		);
		if (broken) {
			await expect(figure).toHaveAttribute("data-load", "broken");
			await expect(figure.getByText("Couldn’t load image")).toBeVisible();
			await expect(figure.getByRole("button")).toHaveCount(0);
		}
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
		if (!broken) await expect(figure.locator("img")).toHaveAttribute("src", src);
	}
	let cut = await figureBox(
		all.nth(cases.findIndex(({ name }) => name === "png that cannot be decoded")),
	);
	expect(Math.abs(cut.frame.width / cut.frame.height / 3 - 1)).toBeLessThan(0.01);
	let valid = cases.flatMap(({ broken }, index) => broken ? [] : [all.nth(index)]);
	let before = [];
	for (let figure of valid) {
		await expect.poll(async () => (await naturalSize(figure)).width).toBeGreaterThan(0);
		await expect(figure).toHaveAttribute("data-load", "loading");
		let held = await figureBox(figure);
		expect(Math.abs(held.frame.width / held.frame.height / (4 / 3) - 1)).toBeLessThan(0.01);
		before.push(held);
	}
	await decoding.release();
	for (let [index, figure] of valid.entries()) {
		await expect(figure).toHaveAttribute("data-load", "shown");
		await settled(figure);
		expect(await figureBox(figure)).toEqual(before[index]);
		expect(await figure.locator("img").boundingBox()).toEqual(
			await figure.locator("[data-chat-image-frame]").boundingBox(),
		);
	}
});

test("a data address whose parameters run long is drawn at its own shape from the first paint, and one that never reaches a comma is not drawn", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let decoding = await holdDecodingOfWrittenImages(page);
	let long = `data:image/png${";name=a.png".repeat(40)};base64,${
		fixture("raster-18x6.png").toString("base64")
	}`;
	let malformed = `data:image/png${" ;".repeat(20_000)}`;
	await seed("# Parameters\n", {
		transcript: oneMessageEachLine(
			[`![many parameters](${long})`, `![never a comma](<${malformed}>)`].join("\n"),
		),
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(2);
	await expect(all.nth(1).getByText("Image can’t be shown")).toBeVisible();
	await expect(all.nth(1).locator(".chat-image-alt")).toHaveText("never a comma");
	let figure = all.nth(0);
	await expect(figure.locator("img")).toHaveAttribute("src", long);
	await expect.poll(async () => (await naturalSize(figure)).width).toBe(18);
	await expect(figure).toHaveAttribute("data-load", "loading");
	await settled(figure);
	let firstSeen = await decoding.firstSeen();
	expect(Math.abs(firstSeen["many parameters"]!.ratio / 3 - 1)).toBeLessThan(0.01);
	let before = await figureBox(figure);
	expect(Math.abs(before.frame.width / before.frame.height / 3 - 1)).toBeLessThan(0.01);
	await decoding.release();
	await expect(figure).toHaveAttribute("data-load", "shown");
	await settled(figure);
	expect(await figureBox(figure)).toEqual(before);
});

function base64Of(markup: string): string {
	return Buffer.from(markup).toString("base64");
}

test("a raster data address whose type Markdown has followed with a space or tab is drawn as Markdown encoded it, at its own shape from the first paint, and one a browser cannot decode or that is not a raster image is not", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(baseURL!).origin,
	});
	let decoding = await holdDecodingOfWrittenImages(page);
	let base64 = fixture("raster-18x6.png").toString("base64");
	let drawn = [
		{
			name: "space before the parameter",
			written: `data:image/png ;base64,${base64}`,
			src: `data:image/png%20;base64,${base64}`,
		},
		{
			name: "tab before the parameter",
			written: `data:image/png\t;base64,${base64}`,
			src: `data:image/png%09;base64,${base64}`,
		},
		{
			name: "capitals and two spaces",
			written: `DATA:IMAGE/PNG  ;BASE64,${base64}`,
			src: `DATA:IMAGE/PNG%20%20;BASE64,${base64}`,
		},
	];
	let undecodable = [
		{ name: "space after the marker", written: `data:image/png;base64 ,${base64}` },
		{
			name: "marker before another parameter",
			written: `data:image/png;base64;charset=utf-8,${base64}`,
		},
	];
	let refused = [
		{
			name: "svg after a space",
			written: `data:image/svg+xml ;base64,${
				base64Of(
					'<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgRan = 1"><script>window.__svgRan = 1</script></svg>',
				)
			}`,
		},
		{
			name: "html after a space",
			written: `data:text/html ;base64,${base64Of("<script>window.__svgRan = 1</script>")}`,
		},
	];
	await seed("# Spaces\n", {
		transcript: oneMessageEachLine(
			[...drawn, ...undecodable, ...refused].map(({ name, written }) => `![${name}](<${written}>)`)
				.join("\n"),
		),
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(drawn.length + undecodable.length + refused.length);
	for (let [index, { name }] of refused.entries()) {
		let figure = all.nth(drawn.length + undecodable.length + index);
		await expect(figure.getByText("Image can’t be shown")).toBeVisible();
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
		await expect(figure.locator("img")).toHaveCount(0);
	}
	for (let [index, { name, src }] of drawn.entries()) {
		let figure = all.nth(index);
		await expect(figure.locator("img")).toHaveAttribute("src", src);
		await expect(figure.locator("img")).toHaveAttribute("alt", name);
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
		await expect.poll(async () => (await naturalSize(figure)).width, name).toBe(18);
		await expect(figure).toHaveAttribute("data-load", "loading");
	}
	for (let [index, { name }] of undecodable.entries()) {
		let figure = all.nth(drawn.length + index);
		await expect(figure).toHaveAttribute("data-load", "broken");
		await expect(figure.getByText("Couldn’t load image")).toBeVisible();
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
	}
	await settled(all.last());
	let firstSeen = await decoding.firstSeen();
	for (let { name } of drawn) {
		expect(firstSeen[name]?.load, name).toBe("loading");
		expect(Math.abs(firstSeen[name]!.ratio / 3 - 1), `${name} at the first paint`).toBeLessThan(
			0.01,
		);
	}
	for (let { name } of undecodable) {
		expect(firstSeen[name]?.load, name).toBe("loading");
		expect(Math.abs(firstSeen[name]!.ratio / (4 / 3) - 1), `${name} at the first paint`)
			.toBeLessThan(0.01);
	}
	let before = await Promise.all(drawn.map((_, index) => figureBox(all.nth(index))));
	for (let [index, { frame }] of before.entries()) {
		expect(Math.abs(frame.width / frame.height / 3 - 1), `${drawn[index]!.name} while it loads`)
			.toBeLessThan(0.01);
	}

	await decoding.release();
	for (let index of drawn.keys()) {
		await expect(all.nth(index)).toHaveAttribute("data-load", "shown");
	}
	await settled(all.last());
	expect(await Promise.all(drawn.map((_, index) => figureBox(all.nth(index))))).toEqual(before);

	let figure = all.nth(0);
	await figure.hover();
	let [download] = await Promise.all([
		page.waitForEvent("download"),
		figure.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(download.suggestedFilename()).toBe("space-before-the-parameter.png");
	expect(readFileSync((await download.path())!).equals(fixture("raster-18x6.png"))).toBe(true);
	await figure.getByRole("button", { name: "Copy image" }).click();
	await expect(figure.getByRole("button", { name: "Copied image" })).toBeVisible();
	expect(
		await page.evaluate(async () => {
			let [item] = await navigator.clipboard.read();
			let blob = await item!.getType("image/png");
			return Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 4));
		}),
	).toEqual([0x89, 0x50, 0x4e, 0x47]);
	expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
});

test("a raster data address with white space before its type, or with no type, is drawn as Markdown made it, at its own shape from the first paint, and SVG or HTML written the same way is not", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(baseURL!).origin,
	});
	let decoding = await holdDecodingOfWrittenImages(page);
	let png = fixture("raster-18x6.png");
	let jpg = fixture("raster-18x6.jpg");
	let pngBase64 = png.toString("base64");
	let jpgBase64 = jpg.toString("base64");
	let percent = [...png].map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
	let drawn = [
		{
			name: "space before the type",
			written: `data: image/png;base64,${pngBase64}`,
			src: `data:%20image/png;base64,${pngBase64}`,
			file: "space-before-the-type.png",
			bytes: png,
		},
		{
			name: "tab before the type, space after",
			written: `data:\timage/png ;base64,${pngBase64}`,
			src: `data:%09image/png%20;base64,${pngBase64}`,
			file: "tab-before-the-type-space-after.png",
			bytes: png,
		},
		{
			name: "no type",
			written: `data:;base64,${pngBase64}`,
			src: `data:;base64,${pngBase64}`,
			file: "no-type.png",
			bytes: png,
		},
		{
			name: "no type, a charset",
			written: `data:;charset=utf-8;base64,${pngBase64}`,
			src: `data:;charset=utf-8;base64,${pngBase64}`,
			file: "no-type-a-charset.png",
			bytes: png,
		},
		{
			name: "a space for a type",
			written: `data: ;base64,${pngBase64}`,
			src: `data:%20;base64,${pngBase64}`,
			file: "a-space-for-a-type.png",
			bytes: png,
		},
		{
			name: "no type, percent-encoded bytes",
			written: `data:,${percent}`,
			src: `data:,${percent}`,
			file: "no-type-percent-encoded-bytes.png",
			bytes: png,
		},
		{
			name: "jpeg after a space",
			written: `data: image/jpeg;base64,${jpgBase64}`,
			src: `data:%20image/jpeg;base64,${jpgBase64}`,
			file: "jpeg-after-a-space.jpg",
			bytes: jpg,
		},
		{
			name: "jpeg with no type",
			written: `data:;base64,${jpgBase64}`,
			src: `data:;base64,${jpgBase64}`,
			file: "jpeg-with-no-type.jpg",
			bytes: jpg,
		},
	];
	let scripted =
		'<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgRan = 1"><script>window.__svgRan = 1</script></svg>';
	let script = "<script>window.__svgRan = 1</script>";
	let refused = [
		{ name: "svg after a space", written: `data: image/svg+xml;base64,${base64Of(scripted)}` },
		{ name: "svg with no type", written: `data:;base64,${base64Of(scripted)}` },
		{ name: "html with no type", written: `data:;base64,${base64Of(script)}` },
		{ name: "markup with no type", written: `data:,${encodeURIComponent(script)}` },
		{ name: "no type, bytes of no image", written: "data:;base64,AAAA" },
	];
	await seed("# Types\n", {
		transcript: oneMessageEachLine(
			[...drawn, ...refused].map(({ name, written }) => `![${name}](<${written}>)`).join("\n"),
		),
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(drawn.length + refused.length);
	for (let [index, { name }] of refused.entries()) {
		let figure = all.nth(drawn.length + index);
		await expect(figure.getByText("Image can’t be shown")).toBeVisible();
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
		await expect(figure.locator("img")).toHaveCount(0);
	}
	for (let figure of await all.all()) await figure.scrollIntoViewIfNeeded();
	await expect.poll(() =>
		all.locator("img").evaluateAll(images =>
			images.filter(image => !(image as HTMLImageElement).naturalWidth).map(image =>
				(image as HTMLImageElement).alt
			)
		)
	).toEqual([]);
	for (let [index, { name, src }] of drawn.entries()) {
		let figure = all.nth(index);
		await expect(figure.locator("img")).toHaveAttribute("src", src);
		await expect(figure.locator("img")).toHaveAttribute("alt", name);
		await expect(figure.locator(".chat-image-alt")).toHaveText(name);
		await expect(figure).toHaveAttribute("data-load", "loading");
		expect(await naturalSize(figure), name).toEqual({ height: 6, width: 18 });
	}
	await settled(all.last());
	let firstSeen = await decoding.firstSeen();
	let before = await Promise.all(drawn.map((_, index) => figureBox(all.nth(index))));
	for (let [index, { name }] of drawn.entries()) {
		expect(firstSeen[name]?.load, name).toBe("loading");
		expect(Math.abs(firstSeen[name]!.ratio / 3 - 1), `${name} at the first paint`).toBeLessThan(
			0.01,
		);
		expect(
			Math.abs(before[index]!.frame.width / before[index]!.frame.height / 3 - 1),
			`${name} while it loads`,
		).toBeLessThan(0.01);
	}

	await decoding.release();
	for (let index of drawn.keys()) {
		await expect(all.nth(index)).toHaveAttribute("data-load", "shown");
	}
	await settled(all.last());
	expect(await Promise.all(drawn.map((_, index) => figureBox(all.nth(index))))).toEqual(before);

	for (let [index, { bytes, file, name }] of drawn.entries()) {
		let figure = all.nth(index);
		await figure.hover();
		let [download] = await Promise.all([
			page.waitForEvent("download"),
			figure.getByRole("button", { name: "Download image" }).click(),
		]);
		expect(download.suggestedFilename(), name).toBe(file);
		expect(readFileSync((await download.path())!).equals(bytes), name).toBe(true);
	}
	for (let index of [0, 2]) {
		let figure = all.nth(index);
		await figure.hover();
		await figure.getByRole("button", { name: "Copy image" }).click();
		await expect(figure.getByRole("button", { name: "Copied image" })).toBeVisible();
		expect(
			await page.evaluate(async () => {
				let [item] = await navigator.clipboard.read();
				let blob = await item!.getType("image/png");
				return Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 4));
			}),
		).toEqual([0x89, 0x50, 0x4e, 0x47]);
	}
	expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
});

test("an address on this site that is not a raster image is never drawn or run, and is read without the reader's session", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let script =
		'<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgRan = 1"><script>window.__svgRan = 1</script></svg>';
	for (
		let [path, contentType] of [["/inline/active.svg", "image/svg+xml"], [
			"/inline/disguised.png",
			"image/png",
		]]
	) {
		await page.route(`**${path}`, route => route.fulfill({ body: script, contentType }));
	}
	await page.context().addCookies([{
		name: "chopin_oauth_state",
		url: baseURL!,
		value: "in-flight-sign-in",
	}]);
	let { sent, settle } = watch(page, ["/inline/", "/icons/favicon.svg", "/docs/", "/auth/"]);
	await seed("# Not images\n", {
		transcript: [{
			id: "not-images",
			author: { kind: "member", handle: "bo" },
			text: [
				"![an active svg](/inline/active.svg)",
				"![a disguised one](/inline/disguised.png)",
				"![the favicon](/icons/favicon.svg)",
				"![a page](docs/diagram.png)",
				"![sign in](/auth/github)",
				"![sign out](auth/logout)",
			].join("\n\n"),
			ts: 1_700_000_000_000,
		}],
	});
	await join("ana");
	let opened = page.url();

	let all = figures(page);
	await expect(all).toHaveCount(6);
	for (
		let [index, alt] of ["an active svg", "a disguised one", "the favicon", "a page"].entries()
	) {
		await expect(all.nth(index)).toHaveAttribute("data-load", "broken");
		await expect(all.nth(index).getByText("Couldn’t load image")).toBeVisible();
		await expect(all.nth(index).getByText(alt, { exact: true })).toBeVisible();
		await expect(all.nth(index).locator("img")).toHaveCount(0);
	}
	for (let [index, alt] of ["sign in", "sign out"].entries()) {
		await expect(all.nth(4 + index).getByText("Image can’t be shown")).toBeVisible();
		await expect(all.nth(4 + index).getByText(alt, { exact: true })).toBeVisible();
		await expect(all.nth(4 + index).locator("img")).toHaveCount(0);
	}
	await settle();
	expect(new Set(sent.map(item => item.path))).toEqual(
		new Set([
			"/inline/active.svg",
			"/inline/disguised.png",
			"/icons/favicon.svg",
			"/docs/diagram.png",
		]),
	);
	for (let item of sent) {
		expect(item.type, item.path).toBe("fetch");
		expect(item.cookie, item.path).toBeUndefined();
	}
	expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
	expect(
		(await page.context().cookies()).find(cookie => cookie.name === "chopin_oauth_state")?.value,
	).toBe("in-flight-sign-in");
	expect(page.url()).toBe(opened);
});

test("raw HTML in a message is never drawn or run, an image tag with a handler included", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let { sent, settle } = watch(page, ["/icons/"]);
	await seed("# Raw\n", {
		transcript: [{
			id: "raw",
			author: { kind: "member", handle: "bo" },
			text: [
				'<img src="/icons/icon-192.png" alt="raw" onerror="window.__raw = 1" onload="window.__raw = 1">',
				'<svg onload="window.__raw = 1"><script>window.__raw = 1</script></svg>',
				"<script>window.__raw = 1</script>",
				`<iframe src="${baseURL}/icons/favicon.svg"></iframe>`,
				"",
				"After the markup.",
			].join("\n"),
			ts: 1_700_000_000_000,
		}],
	});
	await join("ana");

	await expect(page.getByText("After the markup.")).toBeVisible();
	await expect(figures(page)).toHaveCount(0);
	await expect(page.locator("[data-chat-markdown]").locator("img, script, iframe, svg[onload]"))
		.toHaveCount(0);
	await settle();
	expect(sent).toEqual([]);
	expect(await page.evaluate(() => (window as { __raw?: number }).__raw)).toBeUndefined();
});

test("an upload of another document is not drawn in this one, whatever its address says", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let other = crypto.randomUUID();
	await createChannel(port(baseURL), other);
	let theirs = await seedChannelImage(port(baseURL), other, WRITE_BACK, "image/png");
	let ours = await seedChannelImage(port(baseURL), room, CAP, "image/webp");
	let { sent, settle } = watch(page, ["/images/"]);
	await seed("# Mine\n", {
		transcript: [{
			id: "reach",
			author: { kind: "member", handle: "bo" },
			text:
				`![theirs](${theirs}?document=${other}) and ![theirs, unscoped](${theirs}) and ![ours](${ours})`,
			ts: 1_700_000_000_000,
		}],
	});
	await join("ana");

	let all = figures(page);
	await expect(all).toHaveCount(3);
	await expect(all.nth(0)).toHaveAttribute("data-load", "broken");
	await expect(all.nth(1)).toHaveAttribute("data-load", "broken");
	await expect(all.nth(2)).toHaveAttribute("data-load", "shown");
	await settle();
	expect(new Set(sent.map(item => item.path))).toEqual(new Set([theirs, ours]));
	for (let item of sent) {
		expect(new URLSearchParams(item.search).get("document"), item.path).toBe(room);
		expect(item.cookie, item.path).toContain("chopin_session=");
	}
});

test("on a phone the actions are always there, nothing overflows, and the lightbox fits", async ({ baseURL, join, room, seed }) => {
	let stored = await store(baseURL, room);
	await seed("# Phone\n", {
		transcript: [
			...turn(three(stored)),
			{
				id: "solo",
				author: { kind: "agent" },
				text: "And on its own.",
				ts: 1_700_000_500_000,
				images: [three(stored)[0]!],
			},
		],
	});
	let phone = await join("ana", PHONE);
	await openChat(phone);

	let tiles = chat(phone).locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(3);
	await expect(tiles.nth(0)).toHaveAttribute("data-load", "shown");
	await expect(tiles.nth(0).locator(".chat-image-actions")).toHaveCSS("opacity", "0");
	await expect(chat(phone).locator('[data-chat-image="single"] .chat-image-actions')).toHaveCSS(
		"opacity",
		"1",
	);
	for (let tile of await tiles.all()) {
		let box = (await tile.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
	}
	expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await tiles.nth(0).locator("[data-chat-image-frame]").tap({ position: { x: 20, y: 40 } });
	let box = lightbox(phone);
	await expect(box).toBeVisible();
	await expect(box.getByRole("button", { name: "Copy image" })).toBeVisible();
	await expect(box.getByRole("button", { name: "Download image" })).toBeVisible();
	let footer = (await box.locator(".plan-image-lightbox-footer").boundingBox())!;
	expect(footer.x).toBeGreaterThanOrEqual(0);
	expect(footer.x + footer.width).toBeLessThanOrEqual(390);
	expect(footer.y + footer.height).toBeLessThanOrEqual(844);
	for (let name of ["Previous image", "Next image", "Close image preview"]) {
		let target = (await box.getByRole("button", { name }).boundingBox())!;
		expect(target.width).toBeGreaterThanOrEqual(28);
		expect(
			await box.getByRole("button", { name }).evaluate(button =>
				parseFloat(getComputedStyle(button, "::after").width)
			),
		).toBeGreaterThanOrEqual(44);
	}
	await box.getByRole("button", { name: "Next image" }).tap();
	await expect(box.getByRole("status")).toHaveText("Image 2 of 3");
	await box.getByRole("button", { name: "Close image preview" }).tap();
	await expect(box).toHaveCount(0);

	let solo = chat(phone).locator('[data-chat-image="single"]');
	await expect(solo).toHaveCount(1);
	let message = (await solo.locator("xpath=ancestor::div[contains(@class,'chat-message-body')]")
		.boundingBox())!;
	let width = (await solo.boundingBox())!.width;
	expect(width).toBeLessThanOrEqual(384.5);
	expect(width).toBeLessThanOrEqual(message.width + 0.5);
});

test("reduced motion leaves no animation on a loading image or the lightbox", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	let stored = await store(baseURL, room);
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route("**/images/**", async route => {
		await gate;
		await route.continue();
	});
	await seed("# Still\n", { transcript: turn([three(stored)[0]!]) });
	await join("ana");

	let figure = figures(page).first();
	await expect(figure.locator(".chat-image-placeholder")).toBeVisible();
	await expect(figure.locator(".chat-image-placeholder")).toHaveCSS("animation-name", "none");
	release();
	await expect(figure).toHaveAttribute("data-load", "shown");
	await expect(figure.locator("img")).toHaveCSS("transition-duration", "0s");
	await figure.hover();
	await figure.getByRole("button", { name: "Open image", exact: true }).click();
	await expect(lightbox(page)).toBeVisible();
	await expect(lightbox(page)).toHaveCSS("animation-name", "none");
});

test("the images in Chat, and the open lightbox, pass an accessibility check", async ({ baseURL, join, page, room, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let stored = await store(baseURL, room);
	await seed("# Checked\n", {
		transcript: [
			...turn(three(stored)),
			{
				id: "mine",
				author: { kind: "member", handle: "bo" },
				text: `Also ![my picture](${stored.cap}) and ![gone](${NEVER})`,
				ts: 1_700_000_300_000,
			},
		],
	});
	await join("ana");
	await expect(figures(page).nth(0)).toHaveAttribute("data-load", "shown");
	await expect(figures(page).nth(4)).toHaveAttribute("data-load", "broken");

	let found = await new AxeBuilder({ page }).include("[data-chat-scroll]").analyze();
	expect(
		found.violations.map(item => `${item.id}: ${item.nodes.map(node => node.target).join(" ")}`),
	)
		.toEqual([]);

	await figures(page).nth(1).getByRole("button", { name: "Open image", exact: true }).click();
	await expect(lightbox(page)).toBeVisible();
	let open = await new AxeBuilder({ page }).include("dialog.plan-image-lightbox").analyze();
	expect(
		open.violations.map(item => `${item.id}: ${item.nodes.map(node => node.target).join(" ")}`),
	)
		.toEqual([]);
});
