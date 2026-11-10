import { readFileSync } from "node:fs";

import { testChannelPath } from "./database";
import { authenticate, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

test.skip(
	!process.env.E2E_REMOTE_IMAGES,
	"needs the server started with --preload ./e2e/remote-images.ts and E2E_REMOTE_IMAGES=1",
);

const WEBP = readFileSync(new URL("./fixtures/raster-18x6.webp", import.meta.url));
const SHUT = "http://pictures.example/raster-18x6.webp";

function figures(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" })
		.locator("[data-chat-image]");
}

function remote(room: string, url: string): string {
	return `/images/remote?${new URLSearchParams({ document: room, url })}`;
}

test("an image whose host does not let the page read it is copied and saved through Chopin, from the message and the lightbox, and shown as written", async ({ baseURL, join, page, seed }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(baseURL!).origin,
	});
	await page.route(
		"http://pictures.example/**",
		route =>
			route.request().resourceType() === "fetch"
				? route.abort()
				: route.fulfill({ contentType: "image/webp", body: WEBP }),
	);
	await seed("# Out\n", {
		transcript: [{
			id: "shut",
			author: { kind: "member", handle: "bo" },
			text: `![shut away](${SHUT})`,
			ts: 1_700_000_900_000,
		}],
	});
	await join("ana");

	let figure = figures(page).first();
	await expect(figure).toHaveAttribute("data-load", "shown");
	await expect(figure.locator("img")).toHaveAttribute("src", SHUT);
	await figure.hover();
	let [download] = await Promise.all([
		page.waitForEvent("download"),
		figure.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(download.suggestedFilename()).toBe("shut-away.webp");
	expect(readFileSync((await download.path())!).equals(WEBP)).toBe(true);
	await expect(figure.getByRole("button", { name: "Download image" })).toBeVisible();

	await figure.getByRole("button", { name: "Copy image" }).click();
	await expect(figure.getByRole("button", { name: "Copied image" })).toBeVisible();
	let signature = await page.evaluate(async () => {
		let [item] = await navigator.clipboard.read();
		let blob = await item!.getType("image/png");
		return Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 4));
	});
	expect(signature).toEqual([0x89, 0x50, 0x4e, 0x47]);

	await figure.getByRole("button", { name: "Open image", exact: true }).click();
	let box = page.getByRole("dialog", { name: "Image preview", exact: true });
	let [again] = await Promise.all([
		page.waitForEvent("download"),
		box.getByRole("button", { name: "Download image" }).click(),
	]);
	expect(readFileSync((await again.path())!).equals(WEBP)).toBe(true);
	await box.getByRole("button", { name: "Copy image" }).click();
	await expect(box.getByRole("button", { name: "Copied image" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(box).toHaveCount(0);
	await expect(figure.locator("img")).toHaveAttribute("src", SHUT);
});

test("Chopin reads another site's image only for a reader of the document, only as a raster image its Chat draws, and never from this machine", async ({ baseURL, browser, join, page, room, seed }) => {
	let local = `http://127.0.0.1:${new URL(baseURL!).port}/icons/icon-192.png`;
	await seed("# Out\n", {
		transcript: [{
			id: "drawn",
			author: { kind: "member", handle: "bo" },
			text: [
				`![shut away](${SHUT})`,
				"![a drawing](http://pictures.example/gallery-layout.svg)",
				`![this machine](${local})`,
				"[only a link](http://pictures.example/raster-18x6.png)",
			].join("\n\n"),
			ts: 1_700_000_900_000,
		}],
	});
	await join("ana");

	let reader = await page.request.get(remote(room, SHUT));
	expect(reader.status()).toBe(200);
	expect(reader.headers()).toMatchObject({
		"content-type": "image/webp",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'; sandbox",
	});
	expect(Buffer.from(await reader.body()).equals(WEBP)).toBe(true);

	for (
		let url of [
			"http://pictures.example/gallery-layout.svg",
			local,
			"http://pictures.example/raster-18x6.png",
		]
	) {
		let refused = await page.request.get(remote(room, url));
		expect(refused.status(), url).toBe(404);
		expect(await refused.text(), url).toBe("image not found");
	}

	let stranger = await browser.newContext({ baseURL });
	try {
		let strangerPage = await stranger.newPage();
		await authenticate(strangerPage, `score-outsider-${crypto.randomUUID()}`, baseURL!);
		let refused = await stranger.request.get(remote(room, SHUT));
		expect(refused.status()).toBe(404);
		expect(await refused.text()).toBe("image not found");
		await strangerPage.goto(testChannelPath(room));
		await expect(strangerPage.locator("[data-chat-image]")).toHaveCount(0);
	} finally {
		await stranger.close();
	}
	let anonymous = await fetch(new URL(remote(room, SHUT), baseURL));
	expect(anonymous.status).toBe(404);
});
