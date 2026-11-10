import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { imageSize } from "./format";

function bytes(...parts: Array<number[] | string>): Uint8Array {
	return new Uint8Array(
		parts.flatMap(part =>
			typeof part === "string" ? [...part].map(letter => letter.charCodeAt(0)) : part
		),
	);
}

const be32 = (value: number) => [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255];
const be16 = (value: number) => [value >>> 8, value & 255];
const le16 = (value: number) => [value & 255, value >>> 8];
const le24 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16];
const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(width: number, height: number): Uint8Array {
	return bytes(PNG_SIGNATURE, be32(13), "IHDR", be32(width), be32(height), [8, 6, 0, 0, 0]);
}

function jpeg(width: number, height: number, orientation?: number): Uint8Array {
	let exif = orientation === undefined ? [] : [
		0xff,
		0xe1,
		...be16(2 + 6 + 8 + 2 + 12 + 4),
		..."Exif\0\0".split("").map(letter => letter.charCodeAt(0)),
		..."MM".split("").map(letter => letter.charCodeAt(0)),
		...be16(42),
		...be32(8),
		...be16(1),
		...be16(0x0112),
		...be16(3),
		...be32(1),
		...be16(orientation),
		0,
		0,
		...be32(0),
	];
	return bytes(
		[0xff, 0xd8, 0xff, 0xe0],
		be16(16),
		"JFIF\0",
		[1, 1, 0, 0, 1, 0, 1, 0, 0],
		exif,
		[0xff, 0xc0],
		be16(17),
		[8],
		be16(height),
		be16(width),
		[3],
		[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
		[0xff, 0xda],
	);
}

function webp(chunk: string, payload: number[]): Uint8Array {
	return bytes("RIFF", le32(4 + 8 + payload.length), "WEBP", chunk, le32(payload.length), payload);
}

describe("imageSize", () => {
	test("reads a PNG's header", () => {
		expect(imageSize("image/png", png(321, 123))).toEqual({ width: 321, height: 123 });
	});

	test("reads a GIF's logical screen", () => {
		let gif = bytes("GIF89a", le16(640), le16(48), [0, 0, 0]);
		expect(imageSize("image/gif", gif)).toEqual({ width: 640, height: 48 });
		expect(imageSize("image/gif", bytes("GIF87a", le16(7), le16(9)))).toEqual({
			width: 7,
			height: 9,
		});
	});

	test("reads a JPEG's frame, turned by its Exif orientation", () => {
		expect(imageSize("image/jpeg", jpeg(800, 600))).toEqual({ width: 800, height: 600 });
		expect(imageSize("image/jpeg", jpeg(800, 600, 1))).toEqual({ width: 800, height: 600 });
		expect(imageSize("image/jpeg", jpeg(800, 600, 6))).toEqual({ width: 600, height: 800 });
		expect(imageSize("image/jpeg", jpeg(800, 600, 8))).toEqual({ width: 600, height: 800 });
	});

	test("reads lossy, lossless and extended WebP", () => {
		let lossy = webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(300), ...le16(200), 0, 0]);
		expect(imageSize("image/webp", lossy)).toEqual({ width: 300, height: 200 });
		let bits = 76 + 54 * 0x4000;
		let lossless = webp("VP8L", [0x2f, ...le32(bits), 0, 0, 0, 0, 0]);
		expect(imageSize("image/webp", lossless)).toEqual({ width: 77, height: 55 });
		let extended = webp("VP8X", [0x10, 0, 0, 0, ...le24(1535), ...le24(1023)]);
		expect(imageSize("image/webp", extended)).toEqual({ width: 1536, height: 1024 });
	});

	test("reads the browser suite's real pictures", () => {
		let fixture = (name: string) =>
			new Uint8Array(readFileSync(new URL(`../../../../e2e/fixtures/${name}`, import.meta.url)));
		expect(imageSize("image/webp", fixture("the-cap.webp"))).toEqual({ width: 1536, height: 1024 });
		expect(imageSize("image/png", fixture("option-write-back.png"))).toEqual({
			width: 960,
			height: 420,
		});
	});

	test("has no size for bytes that are not a readable image of the type", () => {
		expect(imageSize("image/png", png(0, 10))).toBeUndefined();
		expect(imageSize("image/png", png(10, 10).slice(0, 20))).toBeUndefined();
		expect(imageSize("image/jpeg", png(10, 10))).toBeUndefined();
		expect(imageSize("image/png", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')))
			.toBeUndefined();
		expect(imageSize("image/jpeg", bytes([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeUndefined();
		expect(imageSize("image/webp", webp("VP8 ", [0, 0, 0, 1, 2, 3, 0, 0, 0, 0])))
			.toBeUndefined();
	});
});
