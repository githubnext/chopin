import { HOSTED_IMAGE_PATH } from "@chopin/dialect";

import { dataPayloadStart, readDataAddress } from "./image-size";
import { RASTER_TYPE_NAMES, rasterType } from "./local-image";

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

const RASTER_TYPE = new RegExp(
	`^(?:${RASTER_TYPE_NAMES.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
	"i",
);

const ESCAPED_WHITE_SPACE = /^%(?:09|0[a-d]|20)$/i;

function withoutSurroundingWhiteSpace(type: string): string {
	let start = 0;
	let end = type.length;
	for (;;) {
		if (start < end && /\s/.test(type[start]!)) start += 1;
		else if (start + 3 <= end && ESCAPED_WHITE_SPACE.test(type.slice(start, start + 3))) start += 3;
		else break;
	}
	for (;;) {
		if (end > start && /\s/.test(type[end - 1]!)) end -= 1;
		else if (end - 3 >= start && ESCAPED_WHITE_SPACE.test(type.slice(end - 3, end))) end -= 3;
		else break;
	}
	return type.slice(start, end);
}

const RASTER_HEAD_CHARS = 256;

export function dataImageType(src: string): string | undefined {
	let address = readDataAddress(src);
	if (address === undefined) return undefined;
	let type = withoutSurroundingWhiteSpace(address.type);
	if (type !== "") return RASTER_TYPE.test(type) ? type.toLowerCase() : undefined;
	let head = dataPayloadStart(src, RASTER_HEAD_CHARS);
	return head && rasterType(head);
}

export function isDataImage(src: string): boolean {
	return dataImageType(src) !== undefined;
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
	if (isDataImage(src)) return { kind: "data", url: src };
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

export type GalleryItem =
	| { kind: "image"; index: number }
	| { kind: "refused"; reason: string };

export function galleryItems(
	count: number,
	refusals: ReadonlyArray<{ before: number; reason: string }> | undefined,
	maxVisible = 6,
): GalleryItem[] {
	let { shown } = galleryTiles(count, maxVisible);
	let placed = (refusals ?? []).map(({ before, reason }) => ({
		before: Number.isFinite(before) ? Math.min(Math.max(Math.trunc(before), 0), count) : 0,
		reason,
	})).sort((a, b) => a.before - b.before);
	let items: GalleryItem[] = [];
	let next = 0;
	for (let index = 0; index < shown; index++) {
		for (; next < placed.length && placed[next]!.before <= index; next++) {
			items.push({ kind: "refused", reason: placed[next]!.reason });
		}
		items.push({ kind: "image", index });
	}
	for (; next < placed.length; next++) {
		items.push({ kind: "refused", reason: placed[next]!.reason });
	}
	return items;
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
	let named = type?.split("/")[1] ?? dataImageType(src)?.split("/")[1];
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
