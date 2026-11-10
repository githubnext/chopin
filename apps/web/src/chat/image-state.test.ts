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
