import { describe, expect, test } from "bun:test";

import { apng, bigPng, fixture } from "../images/raster.test-fixtures";
import { inspectImages, savedImages, savedRefusals, toolImages, toolRowOutput } from "./images";

const PNG = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	0,
	0,
	0,
	13,
	0x49,
	0x48,
	0x44,
	0x52,
	0,
	0,
	2,
	0,
	0,
	0,
	1,
	0,
	8,
	6,
	0,
	0,
	0,
]);
const SVG = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const SRC = `/images/${"a".repeat(64)}.png`;

function image(fields: Record<string, unknown> = {}) {
	return { type: "image", data: base64(PNG), mimeType: "image/png", ...fields };
}

describe("tool images", () => {
	test("takes every image block a result carries, in order, with its size and words as given", () => {
		let found = toolImages({
			content: [
				{ type: "text", text: "Image saved to /tmp/out.png" },
				image({ alt: "A floor plan", caption: "Ground floor" }),
				image({ alt: "", caption: "" }),
				image(),
			],
		});
		expect(found.refused).toBe(0);
		expect(found.images).toEqual([
			{
				bytes: PNG,
				mimeType: "image/png",
				width: 512,
				height: 256,
				alt: "A floor plan",
				caption: "Ground floor",
			},
			{ bytes: PNG, mimeType: "image/png", width: 512, height: 256, alt: "", caption: "" },
			{ bytes: PNG, mimeType: "image/png", width: 512, height: 256 },
		]);
	});

	test("reads a result sent as JSON text and ignores keys and words it does not know", () => {
		let found = toolImages(JSON.stringify({
			content: [image({ alt: 7, caption: { text: "no" }, annotations: { audience: ["user"] } })],
			isError: false,
		}));
		expect(found.images).toEqual([{ bytes: PNG, mimeType: "image/png", width: 512, height: 256 }]);
	});

	test("reads JSON text with white space around it or a key written with an escape", () => {
		let text = JSON.stringify({ content: [image({ alt: "A plan" })] });
		for (
			let output of [
				` \n${text}`,
				`\t\r\n${text}\n `,
				text.replace('"content"', '"\\u0063ontent"'),
				` ${text.replace('"content"', '"\\u0063ontent"')} `,
			]
		) {
			expect(toolImages(output).images.map(item => item.alt), output.slice(0, 24)).toEqual([
				"A plan",
			]);
			expect(toolRowOutput(output), output.slice(0, 24)).toBe("1 image");
		}
	});

	test("leaves text that is JSON without image blocks as it was", () => {
		for (let output of [' "content" ', " [1, 2] ", ' {"content": []} ', '{"content": [']) {
			expect(toolImages(output)).toEqual({ images: [], refused: 0 });
			expect(toolRowOutput(output)).toBe(output);
		}
	});

	test("refuses any image Chopin will not host, and keeps the rest", () => {
		let found = toolImages({
			content: [
				image({ data: base64(SVG), mimeType: "image/svg+xml" }),
				image({ data: base64(HTML), mimeType: "text/html" }),
				image({ data: base64(SVG), mimeType: "image/png" }),
				image({ data: "not base64!" }),
				image({ data: base64(new Uint8Array(1_048_577).fill(1)) }),
				image({ data: base64(PNG.slice(0, 20)) }),
				image({ alt: "kept" }),
			],
		});
		expect(found.refused).toBe(6);
		expect(found.images.map(item => item.alt)).toEqual(["kept"]);
	});

	test("hosts every raster a browser draws, as the type its bytes are, under any of its names", () => {
		let found = toolImages({
			content: [
				image({ data: base64(fixture("raster-18x6.avif")), mimeType: "image/avif" }),
				image({ data: base64(fixture("raster-6x18.bmp")), mimeType: "image/bmp" }),
				image({ data: base64(fixture("raster-18x6.bmp")), mimeType: "image/x-ms-bmp" }),
				image({ data: base64(fixture("raster-18x6.ico")), mimeType: "image/x-icon" }),
				image({ data: base64(fixture("raster-6x18.ico")), mimeType: "image/vnd.microsoft.icon" }),
				image({ data: base64(apng(8, 4)), mimeType: "image/apng" }),
				image({ data: base64(fixture("raster-18x6.jpg")), mimeType: "image/jpg" }),
				image({ data: base64(fixture("raster-18x6.gif")), mimeType: "IMAGE/GIF" }),
			],
		});
		expect(found.refused).toBe(0);
		expect(found.images.map(({ mimeType, width, height }) => [mimeType, width, height])).toEqual([
			["image/avif", 18, 6],
			["image/bmp", 6, 18],
			["image/bmp", 18, 6],
			["image/x-icon", 18, 6],
			["image/x-icon", 6, 18],
			["image/png", 8, 4],
			["image/jpeg", 18, 6],
			["image/gif", 18, 6],
		]);
	});

	test("refuses a raster whose type names another, and anything that is not a raster", () => {
		let found = toolImages({
			content: [
				image({ data: base64(fixture("raster-18x6.avif")), mimeType: "image/png" }),
				image({ data: base64(fixture("raster-18x6.bmp")), mimeType: "image/x-icon" }),
				image({ data: base64(PNG), mimeType: "image/svg+xml" }),
				image({ data: base64(PNG), mimeType: "image/heic" }),
				image({ data: base64(SVG), mimeType: "image/avif" }),
				image({ data: base64(HTML), mimeType: "image/x-icon" }),
				image({ data: base64(fixture("raster-18x6.ico").slice(0, 10)), mimeType: "image/x-icon" }),
			],
		});
		expect(found).toEqual({ images: [], refused: 7 });
	});

	test("hosts a picture of any size, a transport's own limit aside", () => {
		for (let size of [1_048_577, 1_080_993, 9 * 1024 * 1024]) {
			let big = bigPng(size);
			let found = toolImages({ content: [image({ data: base64(big), alt: "Big" })] });
			expect(found.refused, `${size}`).toBe(0);
			expect(found.images, `${size}`).toHaveLength(1);
			let [hosted] = found.images;
			expect(hosted, `${size}`).toMatchObject({ mimeType: "image/png", width: 40, height: 30 });
			expect(hosted!.bytes.byteLength, `${size}`).toBe(size);
			expect(Bun.hash(hosted!.bytes), `${size}`).toBe(Bun.hash(big));
		}
	});

	test("finds nothing in a result without image blocks", () => {
		for (
			let output of ["plain text", { content: "text" }, null, 42, {
				content: [{ type: "text", text: "x" }],
			}]
		) {
			expect(toolImages(output)).toEqual({ images: [], refused: 0 });
			expect(toolRowOutput(output)).toBe(output);
		}
	});

	test("shows a tool's row the text of its result and how many images it made, never the bytes", () => {
		let row = toolRowOutput({
			content: [{ type: "text", text: "Saved two drafts" }, image(), image()],
		});
		expect(row).toBe("Saved two drafts\n2 images");
		expect(toolRowOutput({ content: [image()] })).toBe("1 image");
		expect(String(toolRowOutput({ content: [image()] }))).not.toContain(base64(PNG));
	});
});

const SHOWN = "PNG, JPEG, WebP, GIF, AVIF, BMP or ICO";

function reasons(...blocks: unknown[]): string[] {
	return inspectImages({ content: blocks }).refusals.map(refusal => refusal.reason);
}

describe("refused tool images", () => {
	test("says an image type Chat does not show is not one, SVG and HTML among them", () => {
		expect(reasons(
			image({ data: base64(SVG), mimeType: "image/svg+xml" }),
			image({ data: base64(HTML), mimeType: "TEXT/HTML; charset=utf-8" }),
			image({ data: base64(fixture("raster-18x6.avif")), mimeType: "image/heic" }),
			image({ mimeType: "not a type <script>" }),
		)).toEqual([
			`Image couldn't be shown: its type image/svg+xml isn't one Chat shows (${SHOWN}).`,
			`Image couldn't be shown: its type text/html isn't one Chat shows (${SHOWN}).`,
			`Image couldn't be shown: its type image/heic isn't one Chat shows (${SHOWN}).`,
			`Image couldn't be shown: its type isn't one Chat shows (${SHOWN}).`,
		]);
	});

	test("says data that is not base64 is not", () => {
		expect(reasons(
			image({ data: "not base64!" }),
			image({ data: base64(PNG).slice(0, -1) }),
			image({ data: `${base64(PNG)}=====` }),
		)).toEqual(Array(3).fill("Image couldn't be shown: its data isn't valid base64."));
	});

	test("says bytes that are not the image their type names are not, and which raster they are", () => {
		expect(reasons(
			image({ data: base64(SVG) }),
			image({ data: base64(new Uint8Array(1_048_577).fill(1)) }),
			image({ data: base64(HTML), mimeType: "image/x-icon" }),
			image({ data: base64(fixture("raster-18x6.avif")), mimeType: "image/png" }),
			image({ data: base64(PNG), mimeType: "image/vnd.microsoft.icon" }),
		)).toEqual([
			"Image couldn't be shown: its bytes aren't PNG data, as its type says.",
			"Image couldn't be shown: its bytes aren't PNG data, as its type says.",
			"Image couldn't be shown: its bytes aren't ICO data, as its type says.",
			"Image couldn't be shown: its bytes are AVIF data, not PNG as its type says.",
			"Image couldn't be shown: its bytes are PNG data, not ICO as its type says.",
		]);
	});

	test("says an image whose header cannot be read is cut short or damaged", () => {
		expect(reasons(
			image({ data: base64(PNG.slice(0, 20)) }),
			image({ data: base64(fixture("raster-18x6.avif").slice(0, 120)), mimeType: "image/avif" }),
			image({ data: "", mimeType: "image/gif" }),
		)).toEqual([
			"Image couldn't be shown: its PNG header can't be read, so the image is cut short or damaged.",
			"Image couldn't be shown: its AVIF header can't be read, so the image is cut short or damaged.",
			"Image couldn't be shown: its bytes aren't GIF data, as its type says.",
		]);
	});

	test("says a block with no data or no type has none", () => {
		expect(reasons(
			{ type: "image", mimeType: "image/png" },
			{ type: "image", data: base64(PNG) },
			{ type: "image", data: 7, mimeType: "image/png" },
			{ type: "image" },
		)).toEqual(Array(4).fill("Image couldn't be shown: its block has no base64 data or no type."));
	});

	test("keeps the order of the blocks and each duplicate, and where among the shown images each was", () => {
		let found = inspectImages({
			content: [
				{ type: "text", text: "Drew three" },
				image({ alt: "first" }),
				image({ data: base64(SVG), mimeType: "image/svg+xml" }),
				image({ alt: "second" }),
				image({ data: "not base64!" }),
				image({ data: "not base64!" }),
				image({ alt: "third" }),
				image({ data: base64(SVG) }),
			],
		});
		expect(found.images.map(item => item.alt)).toEqual(["first", "second", "third"]);
		expect(found.refusals).toEqual([
			{
				before: 1,
				reason: `Image couldn't be shown: its type image/svg+xml isn't one Chat shows (${SHOWN}).`,
			},
			{ before: 2, reason: "Image couldn't be shown: its data isn't valid base64." },
			{ before: 2, reason: "Image couldn't be shown: its data isn't valid base64." },
			{
				before: 3,
				reason: "Image couldn't be shown: its bytes aren't PNG data, as its type says.",
			},
		]);
		expect(toolImages({ content: [image(), image({ data: base64(SVG) })] }).refused).toBe(1);
	});

	test("says how big an image was that its client left out of one message", () => {
		expect(reasons(
			image({ data: "", tooLarge: 3_650_000, alt: "Plan" }),
			image({ data: "", tooLarge: 1_700_000 }),
			image({ data: base64(PNG), tooLarge: 2_097_152, mimeType: "image/svg+xml" }),
		)).toEqual([
			"Image couldn't be shown: it is 3.5 MiB, which did not fit in one agent connection message (2 MiB at most).",
			"Image couldn't be shown: it is 1.6 MiB, which did not fit in one agent connection message (2 MiB at most).",
			"Image couldn't be shown: it is 2 MiB, which did not fit in one agent connection message (2 MiB at most).",
		]);
		expect(reasons(image({ data: "", tooLarge: "big" }))).toEqual([
			"Image couldn't be shown: its bytes aren't PNG data, as its type says.",
		]);
	});

	test("has nothing to say about a result with no image block or a block it shows", () => {
		for (
			let output of ["plain text", null, 42, { content: [{ type: "text", text: "x" }] }, {
				content: [image()],
			}]
		) {
			expect(inspectImages(output).refusals).toEqual([]);
		}
	});
});

describe("saved images", () => {
	test("admits the images a turn saved", () => {
		expect(savedImages([])).toBe(true);
		expect(savedImages([
			{ src: SRC, alt: "A plan", caption: "", width: 512, height: 256, generated: true },
			{ src: `/images/${"b".repeat(64)}.jpg`, alt: "", width: 1, height: 1 },
			{ src: `/images/${"c".repeat(64)}.webp`, width: 3, height: 4 },
		])).toBe(true);
	});

	test("refuses anything else", () => {
		for (
			let value of [
				undefined,
				{},
				[null],
				[{ src: "https://example.com/a.png", width: 1, height: 1 }],
				[{ src: `/images/${"a".repeat(64)}.svg`, width: 1, height: 1 }],
				[{ src: SRC, width: 0, height: 1 }],
				[{ src: SRC, width: 1.5, height: 1 }],
				[{ src: SRC, width: 1, height: 1, alt: 3 }],
				[{ src: SRC, width: 1, height: 1, caption: null }],
				[{ src: SRC, width: 1, height: 1, generated: false }],
				[{ src: SRC, width: 1, height: 1, bytes: "AAAA" }],
			]
		) expect(savedImages(value)).toBe(false);
	});
});

describe("saved refused images", () => {
	const reason = "Image couldn't be shown: its data isn't valid base64.";

	test("admits what a turn saved, and nothing", () => {
		expect(savedRefusals([])).toBe(true);
		expect(savedRefusals([{ before: 0, reason }, { before: 2, reason }])).toBe(true);
	});

	test("refuses anything else", () => {
		for (
			let value of [
				undefined,
				{},
				[null],
				[{ before: 0 }],
				[{ reason }],
				[{ before: -1, reason }],
				[{ before: 1.5, reason }],
				[{ before: 0, reason: 3 }],
				[{ before: 0, reason: "" }],
				[{ before: 0, reason: "It was not shown." }],
				[{ before: 0, reason, extra: true }],
			]
		) expect(savedRefusals(value)).toBe(false);
	});
});
