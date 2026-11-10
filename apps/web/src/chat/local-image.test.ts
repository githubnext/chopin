import { expect, test } from "bun:test";

import { loadLocalImage } from "./local-image";

const BASE = "https://chopin.example";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0];
const GIF = [...Buffer.from("GIF89a"), 1, 0, 1, 0];
const WEBP = [...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];
const AVIF = [0, 0, 0, 24, ...Buffer.from("ftypmif1"), 0, 0, 0, 0, ...Buffer.from("mif1avif")];
const HEIC = [0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0, ...Buffer.from("mif1heic")];
const BMP = [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0];
const ICO = [0, 0, 1, 0, 1, 0, 16, 16];
const SVG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>1</script></svg>',
);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

type Call = { url: string; init: RequestInit };

function answer(body: Uint8Array | readonly number[] | Buffer, type: string | null, status = 200) {
	let calls: Call[] = [];
	let fetcher = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(new Uint8Array(body), {
			headers: type === null ? {} : { "content-type": type },
			status,
		});
	};
	return { calls, fetcher };
}

const down = () => Promise.reject(new TypeError("Failed to fetch"));

async function bytes(blob: Blob): Promise<number[]> {
	return [...new Uint8Array(await blob.arrayBuffer())];
}

test("an address on this site is read without the reader's session, from this site's root, and as written", async () => {
	let { calls, fetcher } = answer(PNG, "image/png");

	for (
		let src of [
			"/icons/a.png?s=2",
			"icons/a.png?s=2",
			"./icons/a.png?s=2",
			`${BASE}/icons/a.png?s=2`,
		]
	) {
		await loadLocalImage(src, { base: BASE, fetcher });
	}

	expect(calls.map(call => call.url)).toEqual(Array(4).fill(`${BASE}/icons/a.png?s=2`));
	for (let { init } of calls) {
		expect(init.credentials).toBe("omit");
		expect(init.mode).toBe("same-origin");
		expect(init.referrerPolicy).toBe("no-referrer");
	}
});

test("a raster image of any address is drawn as the type its bytes are", async () => {
	for (
		let [body, declared, drawn] of [
			[PNG, "image/png", "image/png"],
			[PNG, "Image/PNG; charset=binary", "image/png"],
			[JPEG, "image/jpeg", "image/jpeg"],
			[JPEG, "image/jpg", "image/jpeg"],
			[GIF, "image/gif", "image/gif"],
			[WEBP, "image/webp", "image/webp"],
			[AVIF, "image/avif", "image/avif"],
			[BMP, "image/x-ms-bmp", "image/bmp"],
			[ICO, "image/vnd.microsoft.icon", "image/x-icon"],
		] as const
	) {
		let blob = await loadLocalImage("/avatar/12", {
			base: BASE,
			fetcher: answer(body, declared).fetcher,
		});
		expect(blob.type, declared).toBe(drawn);
		expect(await bytes(blob), declared).toEqual([...body]);
	}
});

test("SVG is never drawn, whatever it says it is", async () => {
	for (
		let [body, declared] of [
			[SVG, "image/svg+xml"],
			[SVG, "image/svg+xml; charset=utf-8"],
			[SVG, "image/png"],
			[SVG, "text/html"],
			[PNG, "image/svg+xml"],
		] as const
	) {
		let loaded = loadLocalImage("/a.svg", { base: BASE, fetcher: answer(body, declared).fetcher });
		await expect(loaded, declared).rejects.toThrow();
	}
});

test("a page of HTML, such as the app's own for an address it does not know, is never drawn", async () => {
	for (let declared of ["text/html;charset=utf-8", "image/png", "image/jpeg"]) {
		let loaded = loadLocalImage("/docs/diagram.png", {
			base: BASE,
			fetcher: answer(HTML, declared).fetcher,
		});
		await expect(loaded, declared).rejects.toThrow();
	}
});

test("only an answer that is an image of the type it names is drawn", async () => {
	for (
		let [body, declared, status] of [
			[PNG, "image/png", 404],
			[PNG, "image/png", 500],
			[PNG, "application/json", 200],
			[PNG, "application/octet-stream", 200],
			[PNG, null, 200],
			[PNG, "image/jpeg", 200],
			[JPEG, "image/png", 200],
			[PNG, "image/tiff", 200],
			[[0x49, 0x49, 0x2a, 0], "image/tiff", 200],
			[HEIC, "image/avif", 200],
			[[], "image/png", 200],
			[[0x89, 0x50], "image/png", 200],
		] as const
	) {
		let loaded = loadLocalImage("/a.png", {
			base: BASE,
			fetcher: answer(body, declared, status).fetcher,
		});
		await expect(loaded, `${declared} ${status}`).rejects.toThrow();
	}
});

test("an address that cannot be reached, or that is not an address, is not drawn", async () => {
	await expect(loadLocalImage("/a.png", { base: BASE, fetcher: down })).rejects.toThrow();
	await expect(loadLocalImage("http://[", { base: BASE, fetcher: down })).rejects.toThrow();
});

test("giving up on an image stops its request", async () => {
	let controller = new AbortController();
	let { calls, fetcher } = answer(PNG, "image/png");

	await loadLocalImage("/a.png", { base: BASE, fetcher, signal: controller.signal });

	expect(calls[0]!.init.signal).toBe(controller.signal);
});
