import { describe, expect, test } from "bun:test";

import {
	declaredImageType,
	extensionType,
	HOSTED_IMAGE_FILE,
	HOSTED_IMAGE_TYPES,
	imagePath,
	imageSize,
	sniffImageType,
} from "./format";
import { apng, bigPng, fixture } from "./raster.test-fixtures";

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

const RASTERS = [
	["raster-18x6.png", "image/png", 18, 6],
	["raster-6x18.png", "image/png", 6, 18],
	["raster-18x6.jpg", "image/jpeg", 18, 6],
	["raster-6x18.jpg", "image/jpeg", 6, 18],
	["raster-18x6.gif", "image/gif", 18, 6],
	["raster-6x18.webp", "image/webp", 6, 18],
	["raster-18x6.avif", "image/avif", 18, 6],
	["raster-6x18.avif", "image/avif", 6, 18],
	["raster-18x6.bmp", "image/bmp", 18, 6],
	["raster-6x18.bmp", "image/bmp", 6, 18],
	["raster-18x6.ico", "image/x-icon", 18, 6],
	["raster-6x18.ico", "image/x-icon", 6, 18],
] as const;

describe("hosted raster types", () => {
	test("tells a raster by its bytes, whatever it was called", () => {
		for (let [name, type] of RASTERS) expect(sniffImageType(fixture(name)), name).toBe(type);
		expect(sniffImageType(apng(8, 4))).toBe("image/png");
		expect(sniffImageType(bigPng(1_080_993))).toBe("image/png");
	});

	test("never takes SVG, HTML, text or an unknown container for a raster", () => {
		let ftyp = (brands: string) => bytes(be32(16 + brands.length), "ftyp", "heic", be32(0), brands);
		for (
			let [name, head] of [
				["svg", bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
				["html", bytes("<!doctype html><script>alert(1)</script>")],
				["xml with a declaration", bytes('<?xml version="1.0"?><svg/>')],
				["nothing", bytes()],
				["a heic file", ftyp("mif1heic")],
				["an mp4 file", ftyp("isomiso2")],
				["a cursor", bytes([0, 0, 2, 0], le16(1), Array.from({ length: 16 }, () => 1))],
				["an icon with no image", bytes([0, 0, 1, 0, 0, 0])],
				[
					"a bitmap with an unknown header",
					bytes("BM", Array.from({ length: 12 }, () => 0), le32(13)),
				],
				["RIFF that is not WebP", bytes("RIFF", le32(4), "WAVE")],
			] as Array<[string, Uint8Array]>
		) expect(sniffImageType(head), name).toBeUndefined();
	});

	test("takes AVIF from a brand anywhere in its file type box, still image or sequence", () => {
		let ftyp = (major: string, brands: string) =>
			bytes(be32(16 + brands.length), "ftyp", major, be32(0), brands);
		expect(sniffImageType(ftyp("avif", ""))).toBe("image/avif");
		expect(sniffImageType(ftyp("avis", ""))).toBe("image/avif");
		expect(sniffImageType(ftyp("mif1", "miafavif"))).toBe("image/avif");
		expect(sniffImageType(ftyp("mif1", "miafmsf1avis"))).toBe("image/avif");
		expect(sniffImageType(ftyp("mif1", "miafmsf1"))).toBeUndefined();
	});

	test("takes a declared type for the raster its bytes are only when it names that raster", () => {
		expect(declaredImageType("image/png", fixture("raster-18x6.png"))).toBe("image/png");
		expect(declaredImageType("image/apng", apng(8, 4))).toBe("image/png");
		expect(declaredImageType("image/x-png", apng(8, 4))).toBe("image/png");
		expect(declaredImageType("image/jpg", fixture("raster-18x6.jpg"))).toBe("image/jpeg");
		expect(declaredImageType("image/pjpeg", fixture("raster-18x6.jpg"))).toBe("image/jpeg");
		expect(declaredImageType("IMAGE/AVIF; charset=binary", fixture("raster-18x6.avif"))).toBe(
			"image/avif",
		);
		for (let name of ["image/x-bmp", "image/x-ms-bmp", "image/bmp"]) {
			expect(declaredImageType(name, fixture("raster-18x6.bmp")), name).toBe("image/bmp");
		}
		for (let name of ["image/vnd.microsoft.icon", "image/ico", "image/x-icon"]) {
			expect(declaredImageType(name, fixture("raster-18x6.ico")), name).toBe("image/x-icon");
		}
		expect(declaredImageType("image/jpeg", fixture("raster-18x6.png"))).toBeUndefined();
		expect(declaredImageType("image/png", bytes("<svg/>"))).toBeUndefined();
		expect(declaredImageType("image/svg+xml", bytes("<svg/>"))).toBeUndefined();
		expect(declaredImageType("text/html", fixture("raster-18x6.png"))).toBeUndefined();
		expect(declaredImageType("", fixture("raster-18x6.png"))).toBeUndefined();
		expect(declaredImageType("image/heic", fixture("raster-18x6.avif"))).toBeUndefined();
	});

	test("names a file by its hash and the extension of its type, and reads the name back", () => {
		let hash = "0123456789abcdef".repeat(4);
		for (
			let [type, extension] of [
				["image/png", "png"],
				["image/jpeg", "jpg"],
				["image/webp", "webp"],
				["image/gif", "gif"],
				["image/avif", "avif"],
				["image/bmp", "bmp"],
				["image/x-icon", "ico"],
			] as const
		) {
			expect(imagePath(hash, type)).toBe(`/images/${hash}.${extension}`);
			expect(HOSTED_IMAGE_FILE.exec(`${hash}.${extension}`)?.slice(1)).toEqual([hash, extension]);
			expect(extensionType(extension)).toBe(type);
		}
		expect(extensionType("jpeg")).toBe("image/jpeg");
		for (let extension of ["svg", "html", "tiff", "heic", "apng", "cur", "AVIF"]) {
			expect(extensionType(extension), extension).toBeUndefined();
			expect(HOSTED_IMAGE_FILE.test(`${hash}.${extension}`), extension).toBe(false);
		}
		expect([...HOSTED_IMAGE_TYPES].sort()).toEqual([
			"image/avif",
			"image/bmp",
			"image/gif",
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/x-icon",
		]);
	});
});

describe("imageSize of the other browser rasters", () => {
	test("reads the browser suite's real pictures as a browser measures them", () => {
		for (let [name, type, width, height] of RASTERS) {
			expect(imageSize(type, fixture(name)), name).toEqual({ width, height });
		}
	});

	test("reads an AVIF's extent turned a quarter where its rotation says so, and ignores its crop", () => {
		expect(imageSize("image/avif", fixture("raster-18x6-turned.avif"))).toEqual({
			width: 6,
			height: 18,
		});
		expect(imageSize("image/avif", fixture("raster-18x6-cropped.avif"))).toEqual({
			width: 18,
			height: 6,
		});
	});

	test("reads an icon's largest image, the first of those that tie", () => {
		expect(imageSize("image/x-icon", fixture("raster-18x6-two-sizes.ico"))).toEqual({
			width: 18,
			height: 6,
		});
		expect(imageSize("image/x-icon", fixture("raster-18x6-and-6x18.ico"))).toEqual({
			width: 18,
			height: 6,
		});
		let icon = (...entries: Array<[number, number]>) =>
			bytes(
				[0, 0, 1, 0],
				le16(entries.length),
				...entries.map((
					[width, height],
				) => [width, height, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			);
		expect(imageSize("image/x-icon", icon([0, 0]))).toEqual({ width: 256, height: 256 });
		expect(imageSize("image/x-icon", icon([6, 18], [18, 6]))).toEqual({ width: 6, height: 18 });
		expect(imageSize("image/x-icon", icon([16, 16], [32, 32], [24, 24]))).toEqual({
			width: 32,
			height: 32,
		});
	});

	test("reads a bitmap's header of any version, its height as it is stored top down or bottom up", () => {
		let bmp = (header: number[]) => bytes("BM", le32(70), [0, 0, 0, 0], le32(54), header);
		let info = (width: number, height: number) =>
			bytes(
				le32(40),
				le32(width),
				le32(height >>> 0),
				le16(1),
				le16(24),
				Array.from({ length: 24 }, () => 0),
			);
		expect(imageSize("image/bmp", bmp([...info(40, 30)]))).toEqual({ width: 40, height: 30 });
		expect(imageSize("image/bmp", bmp([...info(40, -30)]))).toEqual({ width: 40, height: 30 });
		let core = bytes(le32(12), le16(7), le16(9), le16(1), le16(24));
		expect(imageSize("image/bmp", bmp([...core]))).toEqual({ width: 7, height: 9 });
	});

	test("has no size for a raster whose header cannot be read", () => {
		expect(imageSize("image/avif", fixture("raster-18x6.avif").slice(0, 120))).toBeUndefined();
		expect(imageSize("image/bmp", fixture("raster-18x6.bmp").slice(0, 20))).toBeUndefined();
		expect(imageSize("image/x-icon", fixture("raster-18x6.ico").slice(0, 10))).toBeUndefined();
		expect(imageSize("image/avif", fixture("raster-18x6.png"))).toBeUndefined();
		expect(imageSize("image/png", fixture("raster-18x6.bmp"))).toBeUndefined();
	});

	test("reads an animated PNG as the PNG it is", () => {
		expect(imageSize("image/png", apng(8, 4))).toEqual({ width: 8, height: 4 });
	});
});
