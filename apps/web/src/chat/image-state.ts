import { HOSTED_IMAGE_PATH } from "@chopin/dialect";

import { RASTER_TYPE_NAMES } from "./local-image";

/**
 * Where an image loads from. Hosted is one of this document's own uploads, loaded with the
 * document named, which the server serves only to people who can read it. Data is a raster image
 * written into the message. External is any other address on another site. Local is a path or
 * address on this site that is not an upload: it is read without the reader's credentials, and
 * drawn only if a raster image answers (see `local-image.ts`). Unavailable is never loaded, and
 * includes this site's own sign-in and sign-out addresses.
 */
export type ImageSource =
	| { kind: "hosted"; url: string }
	| { kind: "data"; url: string }
	| { kind: "external"; url: string }
	| { kind: "local"; url: string }
	| { kind: "unavailable" };

const AUTH_PATH = /^\/auth(?:\/|$)/;

const DATA_IMAGE = new RegExp(
	`^data:(?:${
		RASTER_TYPE_NAMES.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
	})(?:;base64)?,`,
	"i",
);

export function isDataImage(src: string): boolean {
	return DATA_IMAGE.test(src);
}

function hosted(path: string, document: string | undefined): ImageSource {
	return document
		? { kind: "hosted", url: `${path}?document=${encodeURIComponent(document)}` }
		: { kind: "unavailable" };
}

export function imageSource(
	src: string | undefined,
	document: string | undefined,
	origin: string,
): ImageSource {
	if (!src) return { kind: "unavailable" };
	if (DATA_IMAGE.test(src)) return { kind: "data", url: src };
	if (HOSTED_IMAGE_PATH.test(src)) return hosted(src, document);
	let base = origin || "https://chat.invalid";
	try {
		let url = new URL(src, base);
		if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unavailable" };
		if (url.origin !== new URL(base).origin) return { kind: "external", url: src };
		if (HOSTED_IMAGE_PATH.test(url.pathname)) return hosted(url.pathname, document);
		if (AUTH_PATH.test(url.pathname)) return { kind: "unavailable" };
		return { kind: "local", url: src };
	} catch {}
	return { kind: "unavailable" };
}

export type Load = "loading" | "shown" | "broken";

export type Settled = { src: string; outcome: "shown" | "broken" };

export function loadState(settled: Settled | undefined, src: string): Load {
	return settled?.src === src ? settled.outcome : "loading";
}

export function settledOnMount(
	image: { complete: boolean; naturalWidth: number },
	src: string,
): Settled | undefined {
	if (!image.complete) return undefined;
	return { src, outcome: image.naturalWidth > 0 ? "shown" : "broken" };
}

export function imageLabel(alt: string | undefined, generated?: boolean): string {
	return alt?.trim() ? alt : generated ? "Generated image" : "Image";
}

export function frameRatio(
	width: number | undefined,
	height: number | undefined,
): string | undefined {
	return width && height && width > 0 && height > 0 ? `${width} / ${height}` : undefined;
}

export function galleryTiles(count: number, maxVisible = 6): { shown: number; more: number } {
	let shown = Math.max(1, Math.min(Math.floor(maxVisible), count));
	return { shown: count === 0 ? 0 : shown, more: Math.max(0, count - shown) };
}

const EXTENSIONS: Record<string, string> = {
	apng: "png",
	"x-png": "png",
	jpeg: "jpg",
	pjpeg: "jpg",
	"x-bmp": "bmp",
	"x-ms-bmp": "bmp",
	"x-icon": "ico",
	"vnd.microsoft.icon": "ico",
};

export function downloadName(alt: string | undefined, src: string, type?: string): string {
	let named = type?.split("/")[1] ?? /^data:image\/([a-z0-9.+-]+)/i.exec(src)?.[1]?.toLowerCase();
	let extension = named
		? EXTENSIONS[named] ?? named
		: /\.([a-z]+)(?:\?|$)/i.exec(src)?.[1]?.toLowerCase() ?? "png";
	let name = (alt ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
		.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
	if (name) return `${name}.${extension}`;
	let stored = /\/([0-9a-f]{64})\.[a-z]+(?:\?|$)/.exec(src)?.[1];
	return `${stored ? `image-${stored.slice(0, 8)}` : "image"}.${extension}`;
}

export type Copied = "idle" | "copied" | "failed";

export function downloadLabel(state: Copied): string {
	return state === "failed" ? "Couldn’t download image" : "Download image";
}

export function copyLabel(state: Copied): string {
	return state === "copied"
		? "Copied image"
		: state === "failed"
		? "Couldn’t copy image"
		: "Copy image";
}
