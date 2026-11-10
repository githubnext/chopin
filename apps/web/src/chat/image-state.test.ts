import { expect, test } from "bun:test";

import {
	copyLabel,
	downloadLabel,
	downloadName,
	frameRatio,
	galleryTiles,
	imageLabel,
	imageSource,
	isDataImage,
	loadState,
	settledOnMount,
} from "./image-state";

const SHA = "a".repeat(64);
const ORIGIN = "https://chopin.example";

test("an upload of this document loads with the document named, however it is written", () => {
	let scoped = { kind: "hosted" as const, url: `/images/${SHA}.png?document=doc%2F1` };

	expect(imageSource(`/images/${SHA}.png`, "doc/1", ORIGIN)).toEqual(scoped);
	expect(imageSource(`${ORIGIN}/images/${SHA}.png`, "doc/1", ORIGIN)).toEqual(scoped);
	expect(imageSource(`/images/${SHA}.png`, undefined, ORIGIN)).toEqual({ kind: "unavailable" });
});

test("a path or address on this site that is not an upload is read without the reader's credentials, as written", () => {
	for (
		let src of [
			"/icons/icon-192.png",
			"icons/icon-192.png",
			"./a.png",
			"../a.png",
			"/avatar/12",
			"/a.png?size=2#top",
			"/authors/a.png",
			`/images/${SHA}.svg`,
			`${ORIGIN}/icons/icon-192.png`,
			`${ORIGIN}/images/${SHA}.svg`,
		]
	) expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "local", url: src });
});

test("this site's own sign-in and sign-out addresses are never requested, however they are written", () => {
	for (
		let src of [
			"/auth/logout",
			"/auth/github",
			"/auth/github/callback?code=x&state=y",
			"auth/logout",
			"../auth/logout",
			"/icons/../auth/logout",
			`${ORIGIN}/auth/logout`,
			`${ORIGIN}/auth`,
		]
	) expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "unavailable" });
});

test("an upload is always read for this document, whatever document its address names", () => {
	expect(imageSource(`/images/${SHA}.png?document=someone-else`, "doc/1", ORIGIN)).toEqual({
		kind: "hosted",
		url: `/images/${SHA}.png?document=doc%2F1`,
	});
	expect(imageSource(`${ORIGIN}/images/${SHA}.webp?document=x#y`, "doc/1", ORIGIN)).toEqual({
		kind: "hosted",
		url: `/images/${SHA}.webp?document=doc%2F1`,
	});
	expect(imageSource(`/images/${SHA}.png?document=someone-else`, undefined, ORIGIN)).toEqual({
		kind: "unavailable",
	});
});

test("an address on another site loads exactly as it was written", () => {
	for (
		let src of [
			"https://example.invalid/pixel.png",
			"http://example.invalid/a.gif",
			"https://example.invalid",
			"//example.invalid/a.png",
			"https://EXAMPLE.invalid/A%20b.png?x=1#top",
		]
	) expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "external", url: src });
});

test("a raster image written into the message loads as it was written, whatever raster format it is", () => {
	for (
		let src of [
			"data:image/png;base64,iVBORw0KGgo=",
			"data:image/apng;base64,iVBORw0KGgo=",
			"data:image/jpeg;base64,/9j/4AAQ",
			"data:image/jpg;base64,/9j/4AAQ",
			"data:image/gif;base64,R0lGODlh",
			"data:image/webp,RIFF",
			"data:image/avif;base64,AAAAHGZ0eXBhdmlm",
			"data:image/bmp;base64,Qk0=",
			"data:image/x-ms-bmp;base64,Qk0=",
			"data:image/x-icon;base64,AAABAAEA",
			"data:image/vnd.microsoft.icon;base64,AAABAAEA",
			"DATA:IMAGE/PNG;base64,AAAA",
		]
	) expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "data", url: src });
	expect(isDataImage("data:image/png;base64,AAAA")).toBe(true);
	expect(isDataImage("data:image/avif;base64,AAAA")).toBe(true);
	expect(isDataImage("data:image/svg+xml,<svg/>")).toBe(false);
});

test("a data address with parameters of its type, or white space around them, is a raster image written into the message as well", () => {
	for (
		let src of [
			"data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
			"data:image/png;name=a.png;base64,AAAA",
			"data:image/png; base64,AAAA",
			"data:image/png ;base64,AAAA",
			"data:image/png;base64 ,AAAA",
			"data:image/jpeg;charset=binary,%FF%D8%FF",
			"data:image/webp;foo;bar=baz;base64,AAAA",
			"DATA:IMAGE/PNG;CHARSET=UTF-8;BASE64,AAAA",
		]
	) {
		expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "data", url: src });
		expect(isDataImage(src), src).toBe(true);
	}
});

test("a raster type that Markdown has followed with percent-encoded white space, as it does a space before a parameter, is a raster image written into the message, loaded as it was written", () => {
	for (
		let src of [
			"data:image/png%20;base64,AAAA",
			"data:image/png%09;base64,AAAA",
			"data:image/png%20%20;base64,AAAA",
			"data:image/png%0a%0B%0c%0D;base64,AAAA",
			"data:image/png %20\t;charset=utf-8;base64,AAAA",
			"data:image/png%20,%89PNG",
			"DATA:IMAGE/PNG%20;BASE64,AAAA",
			"data:image/jpeg%20;base64,/9j/4AAQ",
			"data:image/avif%20;base64,AAAAHGZ0eXBhdmlm",
			"data:image/vnd.microsoft.icon%20;base64,AAABAAEA",
		]
	) {
		expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "data", url: src });
		expect(isDataImage(src), src).toBe(true);
	}
});

const PNG_HEAD = "iVBORw0KGgo=";

function written(bytes: number[]): string {
	return Buffer.from(bytes).toString("base64");
}

const RASTER_HEADS: Array<[string, number[]]> = [
	["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
	["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]],
	["gif", [...Buffer.from("GIF89a")]],
	["webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]],
	["bmp", [...Buffer.from("BM"), ...Array.from({ length: 12 }, () => 0), 40, 0, 0, 0]],
	["ico", [0, 0, 1, 0, 1, 0]],
	["avif", [0, 0, 0, 16, ...Buffer.from("ftypavif"), 0, 0, 0, 0]],
];

test("a raster type that white space Markdown percent-encoded comes before, or that is no type at all, is a raster image written into the message when its bytes are one, loaded as it was written", () => {
	for (
		let src of [
			`data:%20image/png;base64,${PNG_HEAD}`,
			`data: image/png;base64,${PNG_HEAD}`,
			`data:%09image/png;base64,${PNG_HEAD}`,
			`data:%20%20%0a%0DIMAGE/PNG%20%09;BASE64,${PNG_HEAD}`,
			`data:\t image/png%20;charset=utf-8;base64,${PNG_HEAD}`,
			`data:%20image/png,%89PNG%0D%0A%1A%0A`,
			`data:;base64,${PNG_HEAD}`,
			`DATA:;BASE64,${PNG_HEAD}`,
			`data:;charset=utf-8;base64,${PNG_HEAD}`,
			`data:;name=a.png;base64,${PNG_HEAD}`,
			`data:%20;base64,${PNG_HEAD}`,
			`data: ;base64,${PNG_HEAD}`,
			`data:%20%09 ;base64,${PNG_HEAD}`,
			`data:;base64,iVBO\nRw0K\n Ggo=`,
			`data:,%89PNG%0D%0A%1A%0A`,
			`data:,%89%50%4e%47%0d%0a%1a%0a`,
			...RASTER_HEADS.flatMap(([, bytes]) => [
				`data:;base64,${written(bytes)}`,
				`data:%20;base64,${written(bytes)}`,
			]),
		]
	) {
		expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "data", url: src });
		expect(isDataImage(src), src).toBe(true);
	}
});

test("white space before a type never makes SVG, markup or another type a raster image, and an address with no type is one only when its bytes are", () => {
	let svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
	let html = Buffer.from("<html><body onload=alert(1)><script>alert(1)</script>");
	for (
		let src of [
			"data:%20image/svg+xml;base64,PHN2Zy8+",
			"data: image/svg+xml;base64,PHN2Zy8+",
			"data:%09%20image/svg+xml;charset=image/png;base64,PHN2Zy8+",
			"data:%20text/html;base64,PGI+",
			"data: text/html,<script>alert(1)</script>",
			"data:%20image/pngx;base64,AAAA",
			"data:%20image/png+xml;base64,AAAA",
			"data:%20x%20image/png;base64,AAAA",
			"data:%2520image/png;base64,AAAA",
			"data:%2image/png;base64,AAAA",
			"data:%20;image/png;base64,AAAA",
			"data:%20image/png",
			`data:;base64,${svg.toString("base64")}`,
			`data:%20;base64,${svg.toString("base64")}`,
			`data:;charset=image/png;base64,${svg.toString("base64")}`,
			`data:;base64,${html.toString("base64")}`,
			`data:,${encodeURIComponent(svg.toString())}`,
			`data:,${encodeURIComponent(html.toString())}`,
			"data:,<script>alert(1)</script>",
			"data:,",
			"data:;base64,",
			"data:;base64,AAAA",
			"data:;base64,!!!!",
			"data:;base64",
			"data:;image/png;base64,AAAA",
			`data:;base64,${written([0x89, 0x50, 0x4e, 0x47])}`,
			"data:;base64,iVBORw0K",
			`data:,%89PNG`,
			"data:,é",
		]
	) {
		expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "unavailable" });
		expect(isDataImage(src), src).toBe(false);
	}
});

test("percent-encoded white space never makes SVG, markup, another type or a different name a raster image", () => {
	for (
		let src of [
			"data:image/svg+xml%20;base64,PHN2Zy8+",
			"data:image/svg+xml%20;image/png;base64,PHN2Zy8+",
			"data:image/svg+xml%20;charset=image/png,<svg onload=alert(1)/>",
			"data:text/html%20;base64,PHNjcmlwdD4=",
			"data:text/html%09;charset=image/png,<script>alert(1)</script>",
			"data:image/png%20x;base64,AAAA",
			"data:image/pngx%20;base64,AAAA",
			"data:image/png+xml%20;base64,AAAA",
			"data:image/png%2520;base64,AAAA",
			"data:image/png%2;base64,AAAA",
			"data:image/png%20%;base64,AAAA",
			"data:image/png%20",
			"data:image/png%20;base64",
			"data:%20;image/png;base64,AAAA",
		]
	) {
		expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "unavailable" });
		expect(isDataImage(src), src).toBe(false);
	}
});

test("parameters never make SVG, markup or another type a raster image", () => {
	for (
		let src of [
			"data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+",
			"data:image/svg+xml;name=image/png;base64,PHN2Zy8+",
			"data:image/pngx;charset=utf-8;base64,AAAA",
			"data:image/png+xml;charset=utf-8;base64,AAAA",
			"data:text/html;charset=image/png,<script>alert(1)</script>",
			"data:text/html;image/png;base64,PHNjcmlwdD4=",
			"data:;image/png;base64,AAAA",
			"data:image/png;base64",
			"data:image/png;charset=utf-8",
		]
	) {
		expect(imageSource(src, "doc", ORIGIN), src).toEqual({ kind: "unavailable" });
		expect(isDataImage(src), src).toBe(false);
	}
});

test(
	"a data address is classified in time that grows with its length alone, whatever its parameters hold",
	() => {
		let module = new URL("./image-state.ts", import.meta.url).pathname;
		let script = `
		import { imageSource, isDataImage } from ${JSON.stringify(module)};
		let many = 100_000;
		let cases = [
			["data:image/png" + " ;".repeat(many), false],
			["data:image/png" + " ;".repeat(many) + ",AAAA", true],
			["data:image/png" + "\\t;\\u00a0".repeat(many), false],
			["data:image/png" + "\\t;\\u00a0".repeat(many) + ",", true],
			["data:image/png;" + " ".repeat(many * 2), false],
			["data:image/png;" + " ".repeat(many * 2) + ",AAAA", true],
			["data:image/png" + " ".repeat(many * 2), false],
			["data:image/png" + " ".repeat(many * 2) + ",AAAA", true],
			["DATA:IMAGE/PNG" + " ;charset=utf-8".repeat(many) + ";base64,AAAA", true],
			["data:image/png" + " ;".repeat(many) + "x", false],
			["data:image/svg+xml" + " ;".repeat(many) + ",", false],
			["data:" + "image/png".repeat(many) + ",", false],
			["data:image/png" + "%20".repeat(many) + ",", true],
			["data:image/png" + "%20".repeat(many) + "x,", false],
			["data:image/png" + "%2".repeat(many) + ",", false],
			["data:image/png" + " %20\\t".repeat(many) + ";base64,AAAA", true],
			["data:" + "%20".repeat(many) + "image/png,", true],
			["data:" + " %20\\t".repeat(many) + "image/png;base64,AAAA", true],
			["data:" + "%20".repeat(many) + "x" + "%20".repeat(many) + ",", false],
			["data:" + "%2".repeat(many) + "image/png,", false],
			["data:" + " ;".repeat(many) + ",", false],
			["data:" + " ;".repeat(many) + ",%89PNG%0D%0A%1A%0A", true],
			["data:" + "%20".repeat(many) + ";base64,iVBORw0KGgo=", true],
			["data:;base64,iVBORw0KGgo=" + "A".repeat(many * 20), true],
			["data:," + "%00".repeat(many * 20) + "%89PNG%0D%0A%1A%0A", false],
		];
		let outcomes = cases.map(([src, expected]) => [
			isDataImage(src) === expected,
			(imageSource(src, "doc", "https://chopin.example").kind === "data") === expected,
		]);
		console.log(JSON.stringify(outcomes));
	`;
		let run = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: new URL(".", import.meta.url).pathname,
			stderr: "pipe",
			stdout: "pipe",
			timeout: 5_000,
		});

		expect(run.signalCode, run.stderr.toString()).toBeUndefined();
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		expect(JSON.parse(run.stdout.toString())).toEqual(
			Array.from({ length: 25 }, () => [true, true]),
		);
	},
	20_000,
);

test("script, markup, SVG and any other scheme are never loaded", () => {
	for (
		let src of [
			"javascript:alert(1)",
			"data:image/svg+xml;base64,PHN2Zy8+",
			'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
			"data:image/svg,<svg onload=alert(1)/>",
			"DATA:IMAGE/SVG+XML;base64,PHN2Zy8+",
			"data:image/pngx;base64,AAAA",
			"data:image/png+xml;base64,AAAA",
			"data:image/x-icon-html,<script>alert(1)</script>",
			"data:text/html,<script>alert(1)</script>",
			"data:application/pdf;base64,AAAA",
			"blob:https://example.invalid/1",
			"file:///etc/passwd",
			"ftp://example.invalid/a.png",
			"",
			undefined,
		]
	) expect(imageSource(src, "doc", ORIGIN), String(src)).toEqual({ kind: "unavailable" });
});

test("loading settles per address, so a new address starts over", () => {
	expect(loadState(undefined, "a")).toBe("loading");
	expect(loadState({ src: "a", outcome: "shown" }, "a")).toBe("shown");
	expect(loadState({ src: "a", outcome: "broken" }, "a")).toBe("broken");
	expect(loadState({ src: "a", outcome: "shown" }, "b")).toBe("loading");
});

test("an image the browser already has settles on mount, a pending one waits", () => {
	expect(settledOnMount({ complete: false, naturalWidth: 0 }, "a")).toBeUndefined();
	expect(settledOnMount({ complete: true, naturalWidth: 40 }, "a")).toEqual({
		src: "a",
		outcome: "shown",
	});
	expect(settledOnMount({ complete: true, naturalWidth: 0 }, "a")).toEqual({
		src: "a",
		outcome: "broken",
	});
});

test("an image with no alt text is named, and one with alt text keeps it as written", () => {
	expect(imageLabel("A sunrise over the bay")).toBe("A sunrise over the bay");
	expect(imageLabel(undefined)).toBe("Image");
	expect(imageLabel("")).toBe("Image");
	expect(imageLabel("   ", true)).toBe("Generated image");
	expect(imageLabel(undefined, true)).toBe("Generated image");
	expect(imageLabel("  padded ", true)).toBe("  padded ");
});

test("a frame keeps the image's own shape, and has none when the size is not known", () => {
	expect(frameRatio(1024, 768)).toBe("1024 / 768");
	expect(frameRatio(undefined, 10)).toBeUndefined();
	expect(frameRatio(0, 10)).toBeUndefined();
});

test("a gallery draws up to six tiles and the last stands for the rest", () => {
	expect(galleryTiles(0)).toEqual({ shown: 0, more: 0 });
	expect(galleryTiles(2)).toEqual({ shown: 2, more: 0 });
	expect(galleryTiles(6)).toEqual({ shown: 6, more: 0 });
	expect(galleryTiles(9)).toEqual({ shown: 6, more: 3 });
	expect(galleryTiles(9, 4)).toEqual({ shown: 4, more: 5 });
});

test("a download is named for what the image shows, or for the stored image", () => {
	expect(downloadName("Forest cabin, at dusk!", `/images/${SHA}.jpg`)).toBe(
		"forest-cabin-at-dusk.jpg",
	);
	expect(downloadName("Café ☕", `/images/${SHA}.webp?document=x`)).toBe("cafe.webp");
	expect(downloadName(undefined, `/images/${SHA}.png`)).toBe("image-aaaaaaaa.png");
	expect(downloadName("???", `/images/${SHA}.gif`)).toBe("image-aaaaaaaa.gif");
	expect(downloadName("x".repeat(200), `/images/${SHA}.png`)).toBe(`${"x".repeat(60)}.png`);
	expect(downloadName("A dot", "data:image/jpeg;base64,/9j/4AAQ")).toBe("a-dot.jpg");
	expect(downloadName(undefined, "data:image/webp,RIFF")).toBe("image.webp");
});

test("a download of a raster image written with white space before its type, or with no type, is named for the type it is", () => {
	let jpeg = written([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

	expect(downloadName("A dot", `data:%20image/jpeg;base64,${jpeg}`)).toBe("a-dot.jpg");
	expect(downloadName("A dot", `data: image/webp%20;base64,${jpeg}`)).toBe("a-dot.webp");
	expect(downloadName("A dot", `data:;base64,${jpeg}`)).toBe("a-dot.jpg");
	expect(downloadName("A dot", `data:%20;base64,${PNG_HEAD}`)).toBe("a-dot.png");
	expect(downloadName("A dot", `data:,%FF%D8%FF%E0%00%10`)).toBe("a-dot.jpg");
	expect(downloadName(undefined, "data:;base64,AAAA")).toBe("image.png");
});

test("a download from this site is named for the type the image turned out to be, not its address", () => {
	expect(downloadName("A face", "/avatar/12", "image/jpeg")).toBe("a-face.jpg");
	expect(downloadName(undefined, "/avatar/12", "image/png")).toBe("image.png");
	expect(downloadName("Logo", "/logo.png?v=2", "image/webp")).toBe("logo.webp");
	expect(downloadName("Tab", "/favicon", "image/x-icon")).toBe("tab.ico");
	expect(downloadName("Still", "/frame", "image/avif")).toBe("still.avif");
});

test("a download of a raster image written into the message is named for its type", () => {
	for (
		let [type, extension] of [
			["png", "png"],
			["apng", "png"],
			["jpg", "jpg"],
			["avif", "avif"],
			["x-ms-bmp", "bmp"],
			["x-icon", "ico"],
			["vnd.microsoft.icon", "ico"],
		]
	) {
		expect(downloadName("A dot", `data:image/${type};base64,AAAA`), type).toBe(
			`a-dot.${extension}`,
		);
	}
});

test("the copy button says what happened", () => {
	expect(copyLabel("idle")).toBe("Copy image");
	expect(copyLabel("copied")).toBe("Copied image");
	expect(copyLabel("failed")).toBe("Couldn’t copy image");
	expect(downloadLabel("idle")).toBe("Download image");
	expect(downloadLabel("failed")).toBe("Couldn’t download image");
});
