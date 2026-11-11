import { describe, expect, it } from "bun:test";

import { fixture } from "./raster.test-fixtures";
import {
	MAX_STORED_SIDE,
	requestedWidth,
	shrinkToFit,
	thumbnail,
	THUMBNAIL_WIDTHS,
	ThumbnailCache,
} from "./resize";

/** A photo-like image of the given size, made by stretching a fixture. */
async function made(width: number, height: number, type: "jpeg" | "png" | "webp" = "jpeg") {
	let source = new Bun.Image(fixture("option-write-back.png")).resize(width, height);
	let bytes = await (type === "jpeg"
		? source.jpeg({ quality: 95 })
		: type === "png"
		? source.png()
		: source.webp({ quality: 95 })).bytes();
	return bytes;
}

async function size(bytes: Uint8Array) {
	let { width, height, format } = await new Bun.Image(bytes).metadata();
	return { width, height, format };
}

describe("requestedWidth", () => {
	it("takes only Slack's thumbnail widths", () => {
		expect(THUMBNAIL_WIDTHS).toEqual([64, 80, 160, 360, 480, 720, 800, 960, 1024]);
		expect(requestedWidth("480")).toBe(480);
		for (let raw of [null, "", "500", "480.0", "-480", "0480x", "99999"]) {
			expect(requestedWidth(raw)).toBeUndefined();
		}
	});
});

describe("thumbnail", () => {
	it("makes a copy at the asked width, keeping the shape and the type", async () => {
		let original = await made(2400, 1200);
		let copy = await thumbnail(original, "image/jpeg", 480);
		expect(copy?.mimeType).toBe("image/jpeg");
		expect(await size(copy!.bytes)).toEqual({ width: 480, height: 240, format: "jpeg" });
		expect(copy!.bytes.byteLength).toBeLessThan(original.byteLength);
	});

	it("never makes an image larger, and serves a GIF as it is so it keeps moving", async () => {
		expect(await thumbnail(await made(300, 200), "image/jpeg", 360)).toBeUndefined();
		expect(await thumbnail(fixture("raster-18x6.gif"), "image/gif", 64)).toBeUndefined();
	});

	it("keeps a PNG's transparency by writing a PNG", async () => {
		let copy = await thumbnail(await made(1600, 800, "png"), "image/png", 360);
		expect(copy?.mimeType).toBe("image/png");
	});

	it("serves the original when the bytes do not decode", async () => {
		let broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
		expect(await thumbnail(broken, "image/jpeg", 360)).toBeUndefined();
	});
});

describe("shrinkToFit", () => {
	it("stores a very wide image at a size that fits, never at its full width", async () => {
		let original = await made(12000, 6000);
		let fitted = await shrinkToFit(original, "image/jpeg", 300_000);
		expect(fitted).toBeDefined();
		expect(fitted!.bytes.byteLength).toBeLessThanOrEqual(300_000);
		expect(fitted!.width).toBeLessThanOrEqual(MAX_STORED_SIDE);
		expect(fitted!.width / fitted!.height).toBeCloseTo(2, 1);
		expect((await size(fitted!.bytes)).format).toBe("jpeg");
	});

	it("writes anything but a JPEG as WebP", async () => {
		let fitted = await shrinkToFit(await made(1600, 900, "png"), "image/png", 200_000);
		expect(fitted?.mimeType).toBe("image/webp");
	});

	it("gives up on what it cannot decode", async () => {
		expect(await shrinkToFit(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", 10))
			.toBeUndefined();
		expect(await shrinkToFit(fixture("raster-18x6.avif"), "image/avif", 10)).toBeUndefined();
	});
});

describe("ThumbnailCache", () => {
	it("makes a copy once however many ask for it at once", async () => {
		let cache = new ThumbnailCache();
		let made = 0;
		let make = async () => {
			made++;
			return { bytes: new Uint8Array(10), mimeType: "image/png" as const };
		};
		await Promise.all([cache.get("a", make), cache.get("a", make), cache.get("a", make)]);
		await cache.get("a", make);
		expect(made).toBe(1);
	});

	it("forgets the least recently read copy once its budget is spent", async () => {
		let cache = new ThumbnailCache(25);
		let calls: string[] = [];
		let make = (key: string) => async () => {
			calls.push(key);
			return { bytes: new Uint8Array(10), mimeType: "image/png" as const };
		};
		await cache.get("a", make("a"));
		await cache.get("b", make("b"));
		await cache.get("a", make("a"));
		await cache.get("c", make("c"));
		await cache.get("a", make("a"));
		await cache.get("b", make("b"));
		expect(calls).toEqual(["a", "b", "c", "b"]);
	});
});
