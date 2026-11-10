import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { dataImageSize } from "./image-size";

function ascii(text: string): number[] {
	return [...text].map(letter => letter.charCodeAt(0));
}

function filled(length: number, value: number): number[] {
	return Array.from({ length }, () => value);
}

function be(value: number, length: number): number[] {
	return Array.from(
		{ length },
		(_, index) => Math.floor(value / 256 ** (length - 1 - index)) & 0xff,
	);
}

function le(value: number, length: number): number[] {
	return be(value, length).toReversed();
}

function pngBeforeItsData(width: number, height: number, ...chunks: number[][]): number[] {
	return [
		0x89,
		...ascii("PNG\r\n\x1a\n"),
		...be(13, 4),
		...ascii("IHDR"),
		...be(width, 4),
		...be(height, 4),
		8,
		2,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		...chunks.flat(),
	];
}

function png(width: number, height: number, ...chunks: number[][]): number[] {
	return pngBeforeItsData(width, height, ...chunks, pngChunk("IDAT", [0x78, 0x9c]));
}

function dataUrl(bytes: readonly number[], type = "image/png"): string {
	return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

test("a PNG written into a message gives the width and height its header states", () => {
	expect(dataImageSize(dataUrl(png(90, 30)))).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(png(30, 90)))).toEqual({ width: 30, height: 90 });
});

test("the size is read from the payload however the address writes it", () => {
	let bytes = png(90, 30);
	let base64 = Buffer.from(bytes).toString("base64");
	let escaped = bytes.map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
	let expected = { width: 90, height: 30 };

	for (
		let src of [
			`data:image/png;base64,${base64}`,
			`DATA:IMAGE/PNG;BASE64,${base64}`,
			`data:image/png;base64,${base64.replace(/=+$/, "")}`,
			`data:image/png;base64,${base64.replace(/=/g, "%3D")}`,
			`data:image/png;base64,${base64.slice(0, 8)}\n ${base64.slice(8)}`,
			`data:image/png,${escaped}`,
			`data:image/apng;base64,${base64}`,
			`data:image/png;charset=utf-8;base64,${base64}`,
			`data:image/png; base64,${base64}`,
			`data:image/png ;BASE64,${base64}`,
			`data:image/png;name=a.png,${escaped}`,
		]
	) expect(dataImageSize(src), src).toEqual(expected);
});

test("white space Markdown percent-encoded after the type leaves the payload and its base64 marker read as written", () => {
	let base64 = Buffer.from(png(90, 30)).toString("base64");

	for (
		let src of [
			`data:image/png%20;base64,${base64}`,
			`data:image/png%09%20;BASE64,${base64}`,
			`data:image/png%20;charset=utf-8;base64,${base64}`,
		]
	) expect(dataImageSize(src), src).toEqual({ width: 90, height: 30 });
});

test("the base64 marker is the last parameter with only spaces around it, as Chromium reads it, so a payload it does not decode has no size", () => {
	let base64 = Buffer.from(png(90, 30)).toString("base64");

	for (
		let src of [
			`data:image/png; base64 ,${base64}`,
			`data:image/png;  base64  ,${base64}`,
			`data:image/png;foo;base64,${base64}`,
			`data:image/png;base64;x;base64,${base64}`,
		]
	) expect(dataImageSize(src), src).toEqual({ width: 90, height: 30 });
	for (
		let src of [
			`data:image/png;base64\u00a0,${base64}`,
			`data:image/png;\u00a0base64,${base64}`,
			`data:image/png;\u2003base64,${base64}`,
			`data:image/png;\tbase64,${base64}`,
			`data:image/png;base64\n,${base64}`,
			`data:image/png;\u000bbase64,${base64}`,
			`data:image/png;\u000cbase64,${base64}`,
			`data:image/png;base64%20,${base64}`,
			`data:image/png;%20base64,${base64}`,
			`data:image/png;base64;charset=utf-8,${base64}`,
			`data:image/png;x=base64,${base64}`,
		]
	) expect(dataImageSize(src), JSON.stringify(src)).toBeUndefined();
});

test("white space in a base64 payload, written or percent-encoded by Markdown, is skipped however much of it there is, and takes nothing from the part of the payload that is read", () => {
	let bytes = png(90, 30);
	let base64 = Buffer.from(bytes).toString("base64");
	let expected = { width: 90, height: 30 };
	let between = base64.replace(/(.{4})/g, "$1%20");

	for (
		let src of [
			`data:image/png;base64,${" ".repeat(200_000)}${base64}`,
			`data:image/png;base64,${"%20".repeat(40_000)}${base64}`,
			`data:image/png;base64,${"%0D%0A".repeat(30_000)}${base64}`,
			`data:;base64,${"%20".repeat(40_000)}${base64}`,
			`data:;base64,${" \t\n".repeat(50_000)}${base64}`,
			`data:image/png;base64,${between}`,
			`data:image/png;base64,${"%20".repeat(40_000)}${between}`,
			`data:image/png;base64,${base64.slice(0, 20)}${" ".repeat(200_000)}${base64.slice(20)}`,
		]
	) expect(dataImageSize(src), src.slice(0, 50)).toEqual(expected);
	expect(dataImageSize(`data:image/png;base64,${"%20".repeat(40_000)}!!!!`)).toBeUndefined();
	expect(dataImageSize(`data:image/png;base64,${"%20".repeat(40_000)}`)).toBeUndefined();
	expect(dataImageSize(`data:image/png;base64,${"%0B".repeat(2)}${base64}`)).toBeUndefined();
});

test("the bytes decide the format, not the type the address names", () => {
	expect(dataImageSize(dataUrl(png(90, 30), "image/jpeg"))).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(png(90, 30), "image/x-icon"))).toEqual({ width: 90, height: 30 });
});

test("an address whose payload cannot be read, or whose bytes are no raster image, has no size", () => {
	for (
		let src of [
			"",
			"data:",
			"data:image/png;base64,",
			"data:image/png;base64",
			"data:image/png,",
			"data:image/png;base64,iVBORw0KGgo=",
			"data:image/png;base64,!!!!",
			"data:image/png;base64,iVBOR-w0KGgo=",
			`data:image/png;base64,${Buffer.from(png(90, 30).slice(0, 20)).toString("base64")}`,
			"data:image/png;base64,AAAA",
			"data:image/png,é",
			"data:image/svg+xml;base64,PHN2Zy8+",
			"https://example.invalid/a.png",
			"/icons/icon-192.png",
		]
	) expect(dataImageSize(src), src).toBeUndefined();
});

test("a header that states no width or no height gives no shape", () => {
	expect(dataImageSize(dataUrl(png(0, 30)))).toBeUndefined();
	expect(dataImageSize(dataUrl(png(90, 0)))).toBeUndefined();
});

test("only the start of an address is read, so a long one costs a fixed amount and what follows is never looked at", () => {
	let long = `${dataUrl([...png(90, 30), ...filled(200_001, 0)])}!!!!`;

	expect(dataImageSize(long)).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(`data:image/png;base64,${"!".repeat(200_000)}`)).toBeUndefined();
	expect(dataImageSize("x".repeat(5_000_000))).toBeUndefined();
});

function gif(
	screen: [number, number],
	frame: { left?: number; top?: number; size: [number, number] },
	{ before = [], table = 2, version = "89a" }: {
		before?: number[];
		table?: number;
		version?: string;
	} = {},
): number[] {
	let colors = table ? filled(3 * 2 ** table, 0) : [];
	return [
		...ascii(`GIF${version}`),
		...le(screen[0], 2),
		...le(screen[1], 2),
		table ? 0x80 | (table - 1) : 0,
		0,
		0,
		...colors,
		...before,
		0x2c,
		...le(frame.left ?? 0, 2),
		...le(frame.top ?? 0, 2),
		...le(frame.size[0], 2),
		...le(frame.size[1], 2),
		0,
	];
}

test("a GIF is as large as its screen, or as its first frame where that reaches past it", () => {
	expect(dataImageSize(dataUrl(gif([90, 30], { size: [90, 30] }), "image/gif"))).toEqual({
		width: 90,
		height: 30,
	});
	expect(dataImageSize(dataUrl(gif([30, 90], { size: [5, 2] }, { version: "87a" }), "image/gif")))
		.toEqual({ width: 30, height: 90 });
	expect(dataImageSize(dataUrl(gif([10, 4], { size: [30, 6] }), "image/gif"))).toEqual({
		width: 30,
		height: 6,
	});
	expect(dataImageSize(dataUrl(gif([10, 4], { left: 8, size: [5, 2] }), "image/gif"))).toEqual({
		width: 13,
		height: 4,
	});
	expect(dataImageSize(dataUrl(gif([0, 0], { size: [12, 4] }), "image/gif"))).toEqual({
		width: 12,
		height: 4,
	});
});

test("a GIF's extensions and missing colour table are stepped over to its first frame", () => {
	let graphicControl = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
	let comment = [0x21, 0xfe, 3, 0x61, 0x62, 0x63, 2, 0x64, 0x65, 0];
	let size = { size: [90, 30] as [number, number] };

	expect(dataImageSize(dataUrl(gif([90, 30], size, { before: [...comment, ...graphicControl] }))))
		.toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(gif([90, 30], size, { table: 0 })))).toEqual({
		width: 90,
		height: 30,
	});
	expect(dataImageSize(dataUrl(gif([90, 30], size).slice(0, 14)))).toBeUndefined();
	expect(dataImageSize(dataUrl(gif([90, 30], size, { before: [0x3b] })))).toBeUndefined();
	expect(dataImageSize(dataUrl(gif([0, 0], { size: [0, 0] })))).toBeUndefined();
});

function bmp(header: number[], total = 54): number[] {
	return [0x42, 0x4d, ...le(total, 4), 0, 0, 0, 0, ...le(54, 4), ...header];
}

const info = (width: number, height: number, size = 40) => [
	...le(size, 4),
	...le(width >>> 0, 4),
	...le(height >>> 0, 4),
	...le(1, 2),
	...le(24, 2),
	...filled(Math.max(0, size - 16), 0),
];

test("a BMP's size is in its header, whichever of the header's forms it has, and a negative height is a top-down bitmap", () => {
	expect(dataImageSize(dataUrl(bmp(info(90, 30)), "image/bmp"))).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(bmp(info(90, -30)), "image/bmp"))).toEqual({
		width: 90,
		height: 30,
	});
	expect(dataImageSize(dataUrl(bmp(info(90, 30, 124)), "image/bmp"))).toEqual({
		width: 90,
		height: 30,
	});
	expect(
		dataImageSize(
			dataUrl(bmp([...le(12, 4), ...le(18, 2), ...le(6, 2), ...le(1, 2), ...le(24, 2)])),
		),
	).toEqual({ width: 18, height: 6 });
	expect(dataImageSize(dataUrl(bmp(info(0, 30)), "image/bmp"))).toBeUndefined();
	expect(dataImageSize(dataUrl(bmp(info(-90, 30)), "image/bmp"))).toBeUndefined();
});

function webp(chunk: string, body: number[]): number[] {
	let data = [...ascii(chunk), ...le(body.length, 4), ...body];
	return [...ascii("RIFF"), ...le(4 + data.length, 4), ...ascii("WEBP"), ...data];
}

test("a WebP's size is in the first chunk of any of its three forms", () => {
	expect(
		dataImageSize(
			dataUrl(webp("VP8 ", [0x50, 0x05, 0, 0x9d, 0x01, 0x2a, ...le(90, 2), ...le(30, 2)])),
		),
	).toEqual({ width: 90, height: 30 });
	expect(
		dataImageSize(
			dataUrl(
				webp("VP8 ", [
					0,
					0,
					0,
					0x9d,
					0x01,
					0x2a,
					...le(90 | (1 << 14), 2),
					...le(30 | (2 << 14), 2),
				]),
			),
		),
	).toEqual({ width: 90, height: 30 });
	let packed = (89 | (29 << 14)) >>> 0;
	expect(dataImageSize(dataUrl(webp("VP8L", [0x2f, ...le(packed, 4), 0, 0])))).toEqual({
		width: 90,
		height: 30,
	});
	for (let flags of [0, 0x02, 0x10 | 0x08]) {
		expect(
			dataImageSize(dataUrl(webp("VP8X", [flags, 0, 0, 0, ...le(89, 3), ...le(29, 3)]))),
		).toEqual({ width: 90, height: 30 });
	}
	expect(
		dataImageSize(dataUrl(webp("VP8X", [0, 0, 0, 0, ...le(1_999_999, 3), ...le(2, 3)]))),
	).toEqual({ width: 2_000_000, height: 3 });
});

test("a WebP whose first chunk is not one of those, or is cut short, has no size", () => {
	expect(
		dataImageSize(dataUrl(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2b, ...le(90, 2), ...le(30, 2)]))),
	).toBeUndefined();
	expect(dataImageSize(dataUrl(webp("VP8L", [0x2e, ...le(0, 4)])))).toBeUndefined();
	expect(dataImageSize(dataUrl(webp("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))))
		.toBeUndefined();
	expect(dataImageSize(dataUrl(webp("VP8X", [0, 0, 0, 0, ...le(89, 3)])))).toBeUndefined();
	expect(
		dataImageSize(
			dataUrl(webp("VP8 ", [0x50, 0x05, 0, 0x9d, 0x01, 0x2a, ...le(0, 2), ...le(30, 2)])),
		),
	).toBeUndefined();
});

function tiff(
	order: "II" | "MM",
	...entries: Array<[tag: number, value: number, type?: number, count?: number]>
): number[] {
	let word = (value: number) => order === "II" ? le(value, 2) : be(value, 2);
	let long = (value: number) => order === "II" ? le(value, 4) : be(value, 4);
	return [
		...ascii(order),
		...word(42),
		...long(8),
		...word(entries.length),
		...entries.flatMap(([tag, value, type = 3, count = 1]) => [
			...word(tag),
			...word(type),
			...long(count),
			...(type === 4 ? long(value) : [...word(value), 0, 0]),
		]),
		...long(0),
	];
}

const ORIENTATION = 0x0112;

function segment(marker: number, body: number[]): number[] {
	return [0xff, marker, ...be(body.length + 2, 2), ...body];
}

function frame(marker: number, width: number, height: number): number[] {
	return segment(marker, [8, ...be(height, 2), ...be(width, 2), 1, 1, 0x11, 0]);
}

function jpeg(...segments: number[][]): number[] {
	return [0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2];
}

const JFIF = segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const exif = (block: number[]) => segment(0xe1, [...ascii("Exif"), 0, 0, ...block]);

test("a JPEG's size is in its frame header, past whatever segments come before it", () => {
	let table = segment(0xdb, filled(65, 1));
	let large = segment(0xe2, filled(40_000, 7));

	for (let marker of [0xc0, 0xc1, 0xc2]) {
		expect(
			dataImageSize(dataUrl(jpeg(JFIF, table, frame(marker, 90, 30)), "image/jpeg")),
			`SOF${marker - 0xc0}`,
		)
			.toEqual({ width: 90, height: 30 });
	}
	expect(dataImageSize(dataUrl(jpeg(JFIF, large, table, frame(0xc0, 30, 90)), "image/jpeg")))
		.toEqual({ width: 30, height: 90 });
	expect(dataImageSize(dataUrl(jpeg(JFIF, large, large, table, frame(0xc0, 30, 90)), "image/jpeg")))
		.toBeUndefined();
	expect(
		dataImageSize(
			dataUrl([
				0xff,
				0xd8,
				0xff,
				0xff,
				0xff,
				0x01,
				...JFIF,
				...frame(0xc0, 90, 30),
				0xff,
				0xda,
				0,
				2,
			], "image/jpeg"),
		),
	).toEqual({ width: 90, height: 30 });
});

test("a JPEG a browser cannot draw as a frame, or that states no frame, has no size", () => {
	for (let marker of [0xc3, 0xc4, 0xc5, 0xc8, 0xc9, 0xca, 0xcc, 0xcf]) {
		expect(dataImageSize(dataUrl(jpeg(JFIF, frame(marker, 90, 30)), "image/jpeg")), `${marker}`)
			.toBeUndefined();
	}
	expect(dataImageSize(dataUrl(jpeg(JFIF), "image/jpeg"))).toBeUndefined();
	expect(dataImageSize(dataUrl(jpeg(JFIF, frame(0xc0, 90, 0)), "image/jpeg"))).toBeUndefined();
	expect(dataImageSize(dataUrl([0xff, 0xd8, 0xff, 0xd9, ...frame(0xc0, 90, 30)], "image/jpeg")))
		.toBeUndefined();
	expect(
		dataImageSize(dataUrl([0xff, 0xd8, 0xff, 0xe0, 0, 1, ...frame(0xc0, 90, 30)], "image/jpeg")),
	)
		.toBeUndefined();
	expect(dataImageSize(dataUrl(jpeg(JFIF, frame(0xc0, 90, 30)).slice(0, 25), "image/jpeg")))
		.toBeUndefined();
	expect(dataImageSize(dataUrl([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1], "image/jpeg"))).toBeUndefined();
});

test("a JPEG turned by its EXIF orientation is drawn with its width and height exchanged, as Chromium does", () => {
	for (let order of ["II", "MM"] as const) {
		for (
			let [orientation, turned] of [
				[1, false],
				[2, false],
				[3, false],
				[4, false],
				[5, true],
				[6, true],
				[7, true],
				[8, true],
			] as const
		) {
			let bytes = jpeg(JFIF, exif(tiff(order, [ORIENTATION, orientation])), frame(0xc0, 90, 30));
			expect(dataImageSize(dataUrl(bytes, "image/jpeg")), `${order} ${orientation}`).toEqual(
				turned ? { width: 30, height: 90 } : { width: 90, height: 30 },
			);
		}
	}
});

test("an EXIF block that is not readable, or says nothing of orientation, leaves a JPEG as its frame says", () => {
	let plain = { width: 90, height: 30 };
	let make = (block: number[]) => jpeg(JFIF, exif(block), frame(0xc0, 90, 30));

	for (
		let block of [
			tiff("II", [0x0100, 6]),
			tiff("II", [0x0100, 6], [ORIENTATION, 6]).slice(0, 12),
			tiff("II", [ORIENTATION, 0]),
			tiff("II", [ORIENTATION, 9]),
			tiff("MM", [ORIENTATION, 65_535]),
			[...ascii("XX"), ...tiff("II", [ORIENTATION, 6]).slice(2)],
			[...ascii("II"), 0x2b, 0, 8, 0, 0, 0, 0, 0],
			[],
		]
	) expect(dataImageSize(dataUrl(make(block), "image/jpeg")), `${block}`).toEqual(plain);
	expect(
		dataImageSize(
			dataUrl(make(tiff("II", [0x0100, 7], [0x0101, 8], [ORIENTATION, 6])), "image/jpeg"),
		),
	).toEqual({ width: 30, height: 90 });
	expect(
		dataImageSize(
			dataUrl(
				jpeg(
					JFIF,
					segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0]),
					frame(0xc0, 90, 30),
				),
				"image/jpeg",
			),
		),
	).toEqual(plain);
});

function pngChunk(type: string, data: number[]): number[] {
	return [...be(data.length, 4), ...ascii(type), ...data, 0, 0, 0, 0];
}

test("a PNG turned by an eXIf chunk before its image data is drawn with its width and height exchanged", () => {
	let sideways = pngChunk("eXIf", tiff("MM", [ORIENTATION, 6]));
	let upright = pngChunk("eXIf", tiff("II", [ORIENTATION, 1]));
	let gamma = pngChunk("gAMA", [0, 0, 0xb1, 0x8f]);
	let data = pngChunk("IDAT", [0x78, 0x9c]);

	expect(dataImageSize(dataUrl(png(90, 30, gamma, sideways, data)))).toEqual({
		width: 30,
		height: 90,
	});
	expect(dataImageSize(dataUrl(png(90, 30, sideways, gamma, data)))).toEqual({
		width: 30,
		height: 90,
	});
	expect(dataImageSize(dataUrl(png(90, 30, upright, data)))).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(png(90, 30, data, sideways)))).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(png(90, 30, gamma, data)))).toEqual({ width: 90, height: 30 });
	expect(dataImageSize(dataUrl(pngBeforeItsData(90, 30, gamma)))).toBeUndefined();
	expect(dataImageSize(dataUrl(pngBeforeItsData(90, 30)))).toBeUndefined();
});

function ico(...sizes: Array<[width: number, height: number]>): number[] {
	return [
		0,
		0,
		1,
		0,
		...le(sizes.length, 2),
		...sizes.flatMap(([width, height]) => [
			width % 256,
			height % 256,
			0,
			0,
			...le(1, 2),
			...le(32, 2),
			...le(0, 4),
			...le(0, 4),
		]),
	];
}

test("an icon is as large as its largest entry, which is what a browser draws", () => {
	expect(dataImageSize(dataUrl(ico([18, 6]), "image/x-icon"))).toEqual({ width: 18, height: 6 });
	expect(dataImageSize(dataUrl(ico([256, 128]), "image/x-icon"))).toEqual({
		width: 256,
		height: 128,
	});
	expect(dataImageSize(dataUrl(ico([16, 16], [64, 32]), "image/x-icon"))).toEqual({
		width: 64,
		height: 32,
	});
	expect(dataImageSize(dataUrl(ico([64, 32], [16, 16]), "image/x-icon"))).toEqual({
		width: 64,
		height: 32,
	});
	expect(dataImageSize(dataUrl(ico([16, 16], [32, 32], [48, 48]), "image/x-icon"))).toEqual({
		width: 48,
		height: 48,
	});
	expect(dataImageSize(dataUrl(ico([32, 32], [48, 16], [16, 48]), "image/x-icon"))).toEqual({
		width: 32,
		height: 32,
	});
	expect(dataImageSize(dataUrl(ico([16, 16], [16, 16]), "image/x-icon"))).toEqual({
		width: 16,
		height: 16,
	});
});

test("an icon whose largest entries differ in shape, or whose directory is not all read, has no size", () => {
	expect(dataImageSize(dataUrl(ico([48, 16], [16, 48]), "image/x-icon"))).toBeUndefined();
	expect(dataImageSize(dataUrl(ico([16, 16], [32, 8], [8, 32], [4, 4]), "image/x-icon")))
		.toBeUndefined();
	expect(dataImageSize(dataUrl(ico([16, 16], [32, 32]).slice(0, 30), "image/x-icon")))
		.toBeUndefined();
	expect(
		dataImageSize(
			dataUrl(
				[...ico([16, 16]).slice(0, 4), ...le(60_000, 2), ...ico([16, 16]).slice(6)],
				"image/x-icon",
			),
		),
	)
		.toBeUndefined();
});

function box(type: string, ...body: number[][]): number[] {
	let content = body.flat();
	return [...be(8 + content.length, 4), ...ascii(type), ...content];
}

function fullBox(type: string, version: number, flags: number, ...body: number[][]): number[] {
	return box(type, [version, ...be(flags, 3)], ...body);
}

const ispe = (width: number, height: number) => fullBox("ispe", 0, 0, be(width, 4), be(height, 4));
const irot = (angle: number) => box("irot", [angle]);
const imir = (axis: number) => box("imir", [axis]);
const clap = () =>
	box("clap", be(60, 4), be(1, 4), be(30, 4), be(1, 4), be(0, 4), be(1, 4), be(0, 4), be(1, 4));
const pixi = () => fullBox("pixi", 0, 0, [3, 8, 8, 8]);

type Association = { item: number; properties: number[] };

function avif(
	properties: number[][],
	associations: Association[],
	{ primary = 1, pitmVersion = 0, ipmaVersion = 0, wide = false, before = [] }: {
		primary?: number;
		pitmVersion?: number;
		ipmaVersion?: number;
		wide?: boolean;
		before?: number[][];
	} = {},
): number[] {
	let id = (value: number, version: number) => be(value, version ? 4 : 2);
	let entries = associations.flatMap(({ item, properties: indices }) => [
		...id(item, ipmaVersion),
		indices.length,
		...indices.flatMap(index => wide ? be(index, 2) : [index]),
	]);
	return [
		...box("ftyp", ascii("avif"), be(0, 4), ascii("avifmif1miaf")),
		...box(
			"meta",
			[0, 0, 0, 0],
			fullBox("hdlr", 0, 0, be(0, 4), ascii("pict"), filled(13, 0)),
			...before,
			fullBox("pitm", pitmVersion, 0, id(primary, pitmVersion)),
			box(
				"iprp",
				box("ipco", ...properties),
				fullBox("ipma", ipmaVersion, wide ? 1 : 0, be(associations.length, 4), entries),
			),
		),
		...box("mdat", filled(16, 0x12)),
	];
}

test("an AVIF's size is the extent its primary item states, turned a quarter where the item says so", () => {
	let one = (...properties: number[][]) =>
		dataImageSize(
			dataUrl(
				avif(properties, [{
					item: 1,
					properties: properties.map((_, index) => index + 1),
				}]),
				"image/avif",
			),
		);

	expect(one(ispe(90, 30))).toEqual({ width: 90, height: 30 });
	expect(one(pixi(), ispe(30, 90), pixi())).toEqual({ width: 30, height: 90 });
	for (
		let [angle, expected] of [[0, [90, 30]], [1, [30, 90]], [2, [90, 30]], [3, [30, 90]]] as const
	) {
		expect(one(ispe(90, 30), irot(angle)), `irot ${angle}`).toEqual({
			width: expected[0],
			height: expected[1],
		});
	}
	expect(one(ispe(90, 30), irot(0xfd))).toEqual({ width: 30, height: 90 });
	expect(one(ispe(90, 30), imir(0), imir(1))).toEqual({ width: 90, height: 30 });
});

test("an AVIF's size is read for its primary item, however the boxes that name it are written", () => {
	let thumbnail = ispe(10, 10);
	let picture = ispe(90, 30);
	let two = (options: Parameters<typeof avif>[2], associations: Association[]) =>
		dataImageSize(
			dataUrl(avif([thumbnail, picture, irot(1)], associations, options), "image/avif"),
		);

	let both = [{ item: 1, properties: [1] }, { item: 2, properties: [2, 3] }];
	expect(two({ primary: 2 }, both)).toEqual({ width: 30, height: 90 });
	expect(two({ primary: 1 }, both)).toEqual({ width: 10, height: 10 });
	expect(two({ primary: 2, wide: true }, both)).toEqual({ width: 30, height: 90 });
	expect(two({ primary: 2, pitmVersion: 1, ipmaVersion: 1 }, both)).toEqual({
		width: 30,
		height: 90,
	});
	expect(two({ primary: 2 }, [{ item: 2, properties: [0x82, 0x83] }])).toEqual({
		width: 30,
		height: 90,
	});
	expect(two({ primary: 2, wide: true }, [{ item: 2, properties: [0x8002, 0x8003] }])).toEqual({
		width: 30,
		height: 90,
	});
	expect(two({ primary: 2, before: [box("free", filled(300, 0))] }, both)).toEqual({
		width: 30,
		height: 90,
	});
});

test("an AVIF whose primary item has no extent, is cropped, or whose boxes are cut short has no size", () => {
	let none = (properties: number[][], associations: Association[], options = {}) =>
		dataImageSize(dataUrl(avif(properties, associations, options), "image/avif"));

	expect(none([ispe(90, 30)], [{ item: 2, properties: [1] }])).toBeUndefined();
	expect(none([ispe(90, 30)], [{ item: 1, properties: [] }])).toBeUndefined();
	expect(none([ispe(90, 30)], [{ item: 1, properties: [2] }])).toBeUndefined();
	expect(none([ispe(0, 30)], [{ item: 1, properties: [1] }])).toBeUndefined();
	expect(none([ispe(90, 30), clap()], [{ item: 1, properties: [1, 2] }])).toBeUndefined();
	let whole = avif([ispe(90, 30)], [{ item: 1, properties: [1] }]);
	for (let cut of [20, 40, 70, whole.length - 30]) {
		expect(dataImageSize(dataUrl(whole.slice(0, cut), "image/avif")), `${cut}`).toBeUndefined();
	}
});

const FIXTURES = new URL("../../../../e2e/fixtures/", import.meta.url);

test("files an encoder wrote give the size Chromium draws them at, and none where the bytes do not settle it", () => {
	let types: Record<string, string> = {
		avif: "image/avif",
		bmp: "image/bmp",
		gif: "image/gif",
		ico: "image/x-icon",
		jpg: "image/jpeg",
		png: "image/png",
		webp: "image/webp",
	};
	let drawn = (name: string) => {
		let bytes = readFileSync(new URL(name, FIXTURES));
		return dataImageSize(
			`data:${types[name.split(".").pop()!]};base64,${bytes.toString("base64")}`,
		);
	};

	for (let extension of Object.keys(types)) {
		expect(drawn(`raster-18x6.${extension}`), extension).toEqual({ width: 18, height: 6 });
		expect(drawn(`raster-6x18.${extension}`), extension).toEqual({ width: 6, height: 18 });
	}
	for (let extension of ["jpg", "png", "avif"]) {
		expect(drawn(`raster-18x6-turned.${extension}`), extension).toEqual({ width: 6, height: 18 });
	}
	expect(drawn("raster-18x6-two-sizes.ico")).toEqual({ width: 18, height: 6 });
	expect(drawn("raster-18x6-cropped.avif")).toBeUndefined();
	expect(drawn("raster-18x6-and-6x18.ico")).toBeUndefined();
});

test("only the first EXIF block of a JPEG is read, as Chromium reads it, and an orientation is a SHORT of count 1", () => {
	let sideways = exif(tiff("II", [ORIENTATION, 6]));
	let upright = exif(tiff("II", [ORIENTATION, 1]));
	let silent = exif(tiff("II", [0x0100, 6]));
	let wide = { width: 90, height: 30 };
	let tall = { width: 30, height: 90 };
	let make = (...segments: number[][]) =>
		dataImageSize(dataUrl(jpeg(JFIF, ...segments, frame(0xc0, 90, 30)), "image/jpeg"));

	expect(make(upright, sideways)).toEqual(wide);
	expect(make(silent, sideways)).toEqual(wide);
	expect(make(sideways, upright)).toEqual(tall);
	expect(make(exif(tiff("II", [ORIENTATION, 1], [ORIENTATION, 6])))).toEqual(wide);
	expect(make(exif(tiff("MM", [ORIENTATION, 6], [ORIENTATION, 1])))).toEqual(tall);
	expect(make(exif(tiff("II", [ORIENTATION, 6, 4])))).toEqual(wide);
	expect(make(exif(tiff("MM", [ORIENTATION, 6, 4])))).toEqual(wide);
	expect(make(exif(tiff("II", [ORIENTATION, 6, 3, 2])))).toEqual(wide);
	expect(make(exif(tiff("II", [ORIENTATION, 6, 3, 1])))).toEqual(tall);
});

test("an eXIf chunk of a PNG turns it only by an orientation that is a SHORT of count 1, and only when the chunk is whole", () => {
	let data = pngChunk("IDAT", [0x78, 0x9c]);
	let wide = { width: 90, height: 30 };
	let make = (block: number[]) =>
		dataImageSize(dataUrl(png(90, 30, pngChunk("eXIf", block), data)));

	expect(make(tiff("MM", [ORIENTATION, 6, 4]))).toEqual(wide);
	expect(make(tiff("II", [ORIENTATION, 6, 3, 2]))).toEqual(wide);
	expect(make(tiff("MM", [ORIENTATION, 1], [ORIENTATION, 6]))).toEqual(wide);
	expect(make(tiff("MM", [ORIENTATION, 6], [ORIENTATION, 1]))).toEqual({ width: 30, height: 90 });
	let whole = png(90, 30, pngChunk("eXIf", tiff("MM", [ORIENTATION, 6])), data);
	let start = 33;
	for (let cut = start; cut < start + 8 + tiff("MM", [ORIENTATION, 6]).length; cut++) {
		expect(dataImageSize(dataUrl(whole.slice(0, cut))), `cut at ${cut}`).toBeUndefined();
	}
});

function density(
	{ x, y, unit = 2, pixels, inFirstDirectory = false }: {
		x?: number;
		y?: number;
		unit?: number;
		pixels?: [number, number];
		inFirstDirectory?: boolean;
	},
): number[] {
	let entries: Array<[number, number, number, number[]?]> = [];
	let rationals: number[] = [];
	let count = (x === undefined ? 0 : 1) + (y === undefined ? 0 : 1) + 1
		+ (pixels ? (inFirstDirectory ? 2 : 1) : 0);
	let afterDirectory = 8 + 2 + 12 * count + 4;
	for (let [tag, value] of [[0x011a, x], [0x011b, y]] as const) {
		if (value === undefined) continue;
		entries.push([tag, 5, afterDirectory + rationals.length]);
		rationals.push(...be(value, 4), ...be(1, 4));
	}
	entries.push([0x0128, 3, 0, [...be(unit, 2), 0, 0]]);
	let subDirectory: number[] = [];
	if (pixels && inFirstDirectory) {
		entries.push([0xa002, 4, pixels[0]], [0xa003, 4, pixels[1]]);
	} else if (pixels) {
		entries.push([0x8769, 4, afterDirectory + rationals.length]);
		subDirectory = [
			...be(2, 2),
			...be(0xa002, 2),
			...be(4, 2),
			...be(1, 4),
			...be(pixels[0], 4),
			...be(0xa003, 2),
			...be(4, 2),
			...be(1, 4),
			...be(pixels[1], 4),
			...be(0, 4),
		];
	}
	return [
		...ascii("MM"),
		...be(42, 2),
		...be(8, 4),
		...be(entries.length, 2),
		...entries.flatMap(([tag, type, value, inline]) => [
			...be(tag, 2),
			...be(type, 2),
			...be(1, 4),
			...(inline ?? be(value, 4)),
		]),
		...be(0, 4),
		...rationals,
		...subDirectory,
	];
}

test("a JPEG whose EXIF resolution Chromium may apply as a density correction has no size claimed, and any other is its frame", () => {
	let jpegWith = (block: number[]) =>
		dataImageSize(dataUrl(jpeg(exif(block), JFIF, frame(0xc0, 18, 6)), "image/jpeg"));
	let wide = { width: 18, height: 6 };

	for (
		let block of [
			density({ x: 144, y: 72, pixels: [9, 6] }),
			density({ x: 144, y: 72, pixels: [9, 6], inFirstDirectory: true }),
			density({ x: 144, y: 144, pixels: [9, 3] }),
			density({ x: 100, y: 72, pixels: [13, 6] }),
			density({ x: 72, y: 144, pixels: [18, 3] }),
		]
	) expect(jpegWith(block), `${block}`).toBeUndefined();
	for (
		let block of [
			density({ x: 144, y: 72 }),
			density({ x: 144, y: 72, pixels: [18, 6] }),
			density({ x: 144, y: 72, unit: 1, pixels: [9, 6] }),
			density({ x: 144, y: 72, unit: 3, pixels: [9, 6] }),
			density({ x: 144, pixels: [9, 6] }),
			density({ pixels: [9, 6] }),
			density({ x: 72, y: 72, pixels: [4000, 3000] }),
		]
	) expect(jpegWith(block), `${block}`).toEqual(wide);
});

test("a frame header may come after the EXIF block or before it, up to the start of the scan", () => {
	let sideways = exif(tiff("II", [ORIENTATION, 6]));

	expect(
		dataImageSize(dataUrl(jpeg(JFIF, frame(0xc0, 90, 30), sideways), "image/jpeg")),
	).toEqual({ width: 30, height: 90 });
	expect(
		dataImageSize(
			dataUrl(
				[...jpeg(JFIF, frame(0xc0, 90, 30)).slice(0, -4), 0xff, 0xda, 0, 2, ...sideways],
				"image/jpeg",
			),
		),
	).toEqual({ width: 90, height: 30 });
	expect(
		dataImageSize(dataUrl(jpeg(JFIF, frame(0xc0, 90, 30), sideways).slice(0, -8), "image/jpeg")),
	).toBeUndefined();
});

test("no beginning of an encoder's file gives a size other than the file's own, only that size or none", () => {
	let types: Record<string, string> = {
		avif: "image/avif",
		bmp: "image/bmp",
		gif: "image/gif",
		ico: "image/x-icon",
		jpg: "image/jpeg",
		png: "image/png",
		webp: "image/webp",
	};
	let names = [
		...Object.keys(types).flatMap(
			extension => [`raster-18x6.${extension}`, `raster-6x18.${extension}`],
		),
		"raster-18x6-turned.jpg",
		"raster-18x6-turned.png",
		"raster-18x6-turned.avif",
		"raster-18x6-two-sizes.ico",
	];

	for (let name of names) {
		let bytes = readFileSync(new URL(name, FIXTURES));
		let type = types[name.split(".").pop()!]!;
		let whole = dataImageSize(dataUrl([...bytes], type));
		expect(whole, name).toBeDefined();
		for (let cut = 0; cut < bytes.length; cut++) {
			let prefix = dataImageSize(dataUrl([...bytes.subarray(0, cut)], type));
			if (prefix !== undefined) expect(prefix, `${name} cut at ${cut}`).toEqual(whole!);
		}
	}
});

test("a header cut inside a field never gives the size its beginning would, only the size of the whole or none", () => {
	let tall = bmp(info(90, 70_000));
	let wide = bmp(info(70_000, 30));

	for (let bytes of [tall, wide]) {
		let whole = dataImageSize(dataUrl(bytes, "image/bmp"));
		expect(whole).toEqual(
			bytes === tall ? { width: 90, height: 70_000 } : { width: 70_000, height: 30 },
		);
		for (let cut = 0; cut < bytes.length; cut++) {
			let prefix = dataImageSize(dataUrl(bytes.slice(0, cut), "image/bmp"));
			if (prefix !== undefined) expect(prefix, `cut at ${cut}`).toEqual(whole!);
		}
	}
});

test("a data address whose parameters run long still has its shape read, in time that grows with its length alone", () => {
	let base64 = Buffer.from(png(90, 30)).toString("base64");
	let expected = { width: 90, height: 30 };

	expect(dataImageSize(`data:image/png${";name=a.png".repeat(40)};base64,${base64}`)).toEqual(
		expected,
	);
	expect(dataImageSize(`data:image/png${" ;".repeat(100_000)};base64,${base64}`)).toEqual(expected);
	expect(dataImageSize(`data:image/png${" ;".repeat(100_000)} ; BASE64 ,${base64}`)).toEqual(
		expected,
	);
	expect(dataImageSize(`data:image/png${"; base64".repeat(100_000)};x,${base64}`)).toBeUndefined();
	expect(dataImageSize(`data:image/png${" ;".repeat(100_000)}`)).toBeUndefined();
});
