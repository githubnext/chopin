import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatImage } from "./image";
import { ImageGallery } from "./image-gallery";

import type { ChatImageData } from "./image";

function ascii(text: string): number[] {
	return [...text].map(letter => letter.charCodeAt(0));
}

function be(value: number, length: number): number[] {
	return Array.from(
		{ length },
		(_, index) => Math.floor(value / 256 ** (length - 1 - index)) & 0xff,
	);
}

function png(width: number, height: number): string {
	let bytes = [
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
		...be(2, 4),
		...ascii("IDAT"),
		0x78,
		0x9c,
		0,
		0,
		0,
		0,
	];
	return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function firstRender(image: ChatImageData): string {
	return renderToStaticMarkup(<ChatImage image={image} />);
}

function frame(markup: string): { width?: string; height?: string; sized: boolean } {
	let figure = /<figure[^>]*>/.exec(markup)![0];
	return {
		width: /--image-width:([0-9.]+)/.exec(figure)?.[1],
		height: /--image-height:([0-9.]+)/.exec(figure)?.[1],
		sized: figure.includes("data-sized"),
	};
}

test("an image written into a message has its own shape in its frame at the first render, landscape or portrait", () => {
	for (
		let [width, height] of [[90, 30], [30, 90], [64, 64], [1000, 10]] as const
	) {
		let src = png(width, height);
		let markup = firstRender({ src, alt: "A picture the author wrote" });

		expect(frame(markup), `${width} by ${height}`).toEqual({
			width: `${width}`,
			height: `${height}`,
			sized: true,
		});
		expect(markup).toContain('data-load="loading"');
		expect(markup).toContain(`src="${src}"`);
		expect(markup).toContain('alt="A picture the author wrote"');
		expect(markup).toContain(">A picture the author wrote</span>");
	}
});

test("a data address with parameters of its type is drawn, and has its own shape at the first render", () => {
	let plain = png(90, 30);
	let src = plain.replace("data:image/png;base64,", "data:image/png;charset=utf-8;base64,");
	let markup = firstRender({ src, alt: "With a parameter" });

	expect(frame(markup)).toEqual({ width: "90", height: "30", sized: true });
	expect(markup).toContain(`src="${src}"`);
	expect(markup).not.toContain("Image can’t be shown");
});

test("a data address whose type Markdown followed with percent-encoded white space is drawn as written, and has its own shape at the first render", () => {
	let src = png(90, 30).replace("data:image/png;", "data:image/png%20;");
	let markup = firstRender({ src, alt: "With a space" });

	expect(frame(markup)).toEqual({ width: "90", height: "30", sized: true });
	expect(markup).toContain(`src="${src}"`);
	expect(markup).not.toContain("Image can’t be shown");
});

test("a size the image part states wins over what the bytes of a data address say", () => {
	let markup = firstRender({ src: png(90, 30), alt: "Stated", width: 30, height: 90 });

	expect(frame(markup)).toEqual({ width: "30", height: "90", sized: true });
	expect(frame(firstRender({ src: png(90, 30), width: 30 }))).toEqual({
		width: "90",
		height: "30",
		sized: true,
	});
});

test("an image whose shape cannot be known when it is first drawn keeps the fixed frame, and is not refused", () => {
	let cases: ChatImageData[] = [
		{ src: "https://example.invalid/wide.png", alt: "Another site" },
		{ src: "/icons/icon-192.png", alt: "This site" },
		{ src: "data:image/png;base64,AAAA", alt: "Not a PNG" },
		{ src: "data:image/png;base64,", alt: "Empty" },
		{ src: "data:image/webp,RIFF", alt: "Unusual" },
		{ src: png(0, 30), alt: "No width" },
	];

	for (let image of cases) {
		let markup = firstRender(image);

		expect(frame(markup), image.src).toEqual({ sized: false });
		expect(markup, image.src).toContain(`>${image.alt}</span>`);
		expect(markup, image.src).toContain('data-load="loading"');
	}
	expect(firstRender(cases[2]!)).toContain('src="data:image/png;base64,AAAA"');
	expect(firstRender({ src: "data:image/svg+xml;base64,PHN2Zy8+", alt: "Never" })).toContain(
		"Image can’t be shown",
	);
});

test("a gallery tile of a data address has its own shape at the first render as well", () => {
	let markup = renderToStaticMarkup(
		<ImageGallery
			images={[{ src: png(90, 30), alt: "Wide" }, { src: png(30, 90), alt: "Tall" }]}
		/>,
	);
	let figures = markup.match(/<figure[^>]*>/g)!;

	expect(figures).toHaveLength(2);
	expect(figures[0]).toContain("--image-width:90;--image-height:30");
	expect(figures[1]).toContain("--image-width:30;--image-height:90");
});
