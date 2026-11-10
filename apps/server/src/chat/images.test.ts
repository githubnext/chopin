import { describe, expect, test } from "bun:test";

import { savedImages, toolImages, toolRowOutput } from "./images";

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
