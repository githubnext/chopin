/**
 * Smaller copies of a stored image, the way Slack keeps its `thumb_*` sizes: the original is kept,
 * a copy at a fixed width is made the first time it is asked for, and the copy is what a message
 * draws. Where an image is more than Chopin can store, a smaller copy is stored in its place.
 *
 * Decoding runs in `Bun.Image`, built into Bun: off the JavaScript thread, refusing a header that
 * names more than `MAX_DECODED_PIXELS` before it allocates any pixels, and reading a JPEG at the
 * nearest eighth of its size. Only PNG, JPEG, WebP, GIF and BMP are decoded, never SVG or anything
 * that can carry script, and a decode that does not end in `RESIZE_TIMEOUT_MS` is given up on.
 */

import type { HostedImageType } from "./format";

/** Slack's thumbnail sizes (`thumb_64` to `thumb_1024`), as widths in CSS pixels. */
export const THUMBNAIL_WIDTHS = [64, 80, 160, 360, 480, 720, 800, 960, 1024] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];

/** About 160 MB of RGBA at most for one decode. */
export const MAX_DECODED_PIXELS = 40_000_000;
/**
 * A JPEG shrunk to half its size or less is decoded at the nearest eighth of it, so its header may
 * name more: at most this many pixels (Sharp's default), which decode into no more than a 4096px
 * square.
 */
const MAX_SCALED_JPEG_PIXELS = 268_402_689;
/** The longest side a downscaled original is stored at. */
export const MAX_STORED_SIDE = 4096;
/** The narrowest a downscaled original is made before shrinking gives up. */
const MIN_STORED_SIDE = 256;
export const RESIZE_TIMEOUT_MS = 15_000;
/** Decodes running at once, so a burst of first reads cannot hold many pixel buffers together. */
const CONCURRENT_DECODES = 2;

/** What `Bun.Image` decodes on every platform; AVIF and icons are served as they are. */
const DECODED: ReadonlySet<HostedImageType> = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/bmp",
]);

export type Resized = { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" | "image/webp" };

export function isThumbnailWidth(value: number): value is ThumbnailWidth {
	return THUMBNAIL_WIDTHS.includes(value as ThumbnailWidth);
}

/** The width a request asks for, or undefined where it names none Chopin makes. */
export function requestedWidth(raw: string | null): ThumbnailWidth | undefined {
	if (raw === null || !/^\d{1,4}$/.test(raw)) return undefined;
	let width = Number(raw);
	return isThumbnailWidth(width) ? width : undefined;
}

let running = 0;
let waiting: Array<() => void> = [];

async function bounded<T>(work: () => Promise<T>): Promise<T> {
	if (running >= CONCURRENT_DECODES) await new Promise<void>(resolve => waiting.push(resolve));
	running++;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("image resize timed out")), RESIZE_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
		running--;
		waiting.shift()?.();
	}
}

type Meta = { width: number; height: number };

/** A decode of the image toward a box `side` pixels wide, with the pixel bound that decode needs. */
function image(bytes: Uint8Array, type: HostedImageType, meta: Meta, side: number): Bun.Image {
	let scaled = type === "image/jpeg" && side * 2 <= Math.max(meta.width, meta.height);
	// A copy, so nothing the caller does to its buffer reaches a decode running off-thread.
	return new Bun.Image(bytes.slice(), {
		maxPixels: scaled ? MAX_SCALED_JPEG_PIXELS : MAX_DECODED_PIXELS,
	});
}

function header(bytes: Uint8Array): Promise<Meta> {
	return new Bun.Image(bytes.slice()).metadata();
}

/** The type a smaller copy is written as: a JPEG stays one, and anything else keeps its alpha. */
function outputType(type: HostedImageType): Resized["mimeType"] {
	return type === "image/jpeg" ? "image/jpeg" : type === "image/png" ? "image/png" : "image/webp";
}

function encode(pipeline: Bun.Image, type: Resized["mimeType"], quality = 82): Bun.Image {
	return type === "image/jpeg"
		? pipeline.jpeg({ quality })
		: type === "image/png"
		? pipeline.png({ compressionLevel: 6 })
		: pipeline.webp({ quality });
}

/**
 * A copy `width` pixels wide, never wider than the image, or undefined where the original should
 * be served instead: a GIF (whose copy would lose its animation), a type not decoded here, an
 * image already that narrow, one that does not decode, or a copy no smaller than the original.
 */
export async function thumbnail(
	bytes: Uint8Array,
	type: HostedImageType,
	width: ThumbnailWidth,
): Promise<Resized | undefined> {
	if (!DECODED.has(type) || type === "image/gif") return undefined;
	try {
		return await bounded(async () => {
			let meta = await header(bytes);
			if (meta.width <= width) return undefined;
			let mimeType = outputType(type);
			let copy = await encode(
				image(bytes, type, meta, width).resize(width, width * 4, {
					fit: "inside",
					withoutEnlargement: true,
				}),
				mimeType,
			).bytes();
			return copy.byteLength < bytes.byteLength ? { bytes: copy, mimeType } : undefined;
		});
	} catch {
		return undefined;
	}
}

/**
 * The image made small enough to store in `maxBytes`, keeping its shape: at most
 * `MAX_STORED_SIDE` on its longest side, then narrower until it fits. A JPEG stays a JPEG and
 * anything else becomes a WebP, which keeps transparency (a GIF keeps its first frame).
 * Undefined where it cannot be decoded or will not fit even at `MIN_STORED_SIDE`.
 */
export async function shrinkToFit(
	bytes: Uint8Array,
	type: HostedImageType,
	maxBytes: number,
): Promise<(Resized & { width: number; height: number }) | undefined> {
	if (!DECODED.has(type)) return undefined;
	let mimeType = type === "image/jpeg" ? "image/jpeg" as const : "image/webp" as const;
	try {
		return await bounded(async () => {
			let meta = await header(bytes);
			let side = Math.min(Math.max(meta.width, meta.height), MAX_STORED_SIDE);
			for (let quality of [82, 70]) {
				for (
					let box = side;
					box === side || box >= MIN_STORED_SIDE;
					box = Math.floor(box * 0.75)
				) {
					let pipeline = encode(
						image(bytes, type, meta, box).resize(box, box, {
							fit: "inside",
							withoutEnlargement: true,
						}),
						mimeType,
						quality,
					);
					let copy = await pipeline.bytes();
					if (copy.byteLength <= maxBytes) {
						return { bytes: copy, mimeType, width: pipeline.width, height: pipeline.height };
					}
				}
			}
			return undefined;
		});
	} catch {
		return undefined;
	}
}

/**
 * Smaller copies already made, by the bytes they take: a cache, so a restart only makes them
 * again. The oldest read goes first once `budget` bytes are held.
 */
export class ThumbnailCache {
	#entries = new Map<string, Resized | null>();
	#pending = new Map<string, Promise<Resized | undefined>>();
	#held = 0;

	constructor(readonly budget = 64 * 1_048_576) {}

	async get(
		key: string,
		make: () => Promise<Resized | undefined>,
	): Promise<Resized | undefined> {
		if (this.#entries.has(key)) {
			let found = this.#entries.get(key)!;
			this.#entries.delete(key);
			this.#entries.set(key, found);
			return found ?? undefined;
		}
		let pending = this.#pending.get(key);
		if (pending) return pending;
		let made = make().finally(() => this.#pending.delete(key));
		this.#pending.set(key, made);
		let result = await made;
		this.#remember(key, result ?? null);
		return result;
	}

	#remember(key: string, value: Resized | null): void {
		let size = value?.bytes.byteLength ?? 0;
		if (size > this.budget) return;
		this.#entries.set(key, value);
		this.#held += size;
		for (let [oldest, entry] of this.#entries) {
			if (this.#held <= this.budget) break;
			this.#entries.delete(oldest);
			this.#held -= entry?.bytes.byteLength ?? 0;
		}
	}
}

const shared = new ThumbnailCache();

/**
 * What a read of a stored image serves: the copy at `width` where one is asked for and is worth
 * making, else the original. `key` names the stored bytes, so two reads of them share one copy.
 */
export async function served(
	key: string,
	original: { bytes: Uint8Array; mimeType: string },
	type: HostedImageType,
	width: ThumbnailWidth | undefined,
	cache = shared,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
	if (width === undefined) return original;
	let copy = await cache.get(`${key}@${width}`, () => thumbnail(original.bytes, type, width));
	return copy ?? original;
}
