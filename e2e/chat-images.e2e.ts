import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { seedChannelImage, testChannelPath } from "./database";
import { authenticate, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";

const CAP = readFileSync(new URL("./fixtures/the-cap.webp", import.meta.url));
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
	for (let tile of await tiles.all()) {
		await expect(tile).toHaveAttribute("data-load", "shown");
		let box = (await tile.locator("[data-chat-image-frame]").boundingBox())!;
		expect(box.width / box.height).toBeCloseTo(4 / 3, 1);
	}
	await expect(tiles.nth(0).getByText("The cap is a balance of 100.")).toBeVisible();
	await expect(tiles.nth(1).getByText("Faster, and a crash can lose the last writes."))
		.toBeVisible();
	await expect(tiles.nth(2).getByText("Write-through: write, cache, database")).toBeVisible();
	let first = (await tiles.nth(0).boundingBox())!;
	let third = (await tiles.nth(2).boundingBox())!;
	expect(third.y).toBe(first.y);
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
	await tiles.nth(1).locator("[data-chat-image-frame]").click({ position: { x: 20, y: 60 } });
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

	await tiles.nth(0).locator("[data-chat-image-frame]").click({ position: { x: 20, y: 60 } });
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
	await expect(all.nth(4).getByText("Image can’t be shown")).toBeVisible();
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
