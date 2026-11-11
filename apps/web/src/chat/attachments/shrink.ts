/**
 * An image too large to send, made smaller in the browser before it is uploaded, so a photo is
 * never refused for its size. Slack keeps any original; Chopin keeps one up to the server's
 * per-file cap (`CHAT_ATTACHMENT_MAX_BYTES`, at most 1 MiB under a remote Planner, whose turn
 * carries its files in one connection message), so a larger one is sent as a smaller copy of
 * itself. The browser decodes it, on the person's own machine, so the server never decodes a
 * 12000-pixel photo; the server then reads what it stored at Slack's thumbnail widths.
 */

import { rasterSize } from "../image-size";

import type { ImageSize } from "../image-size";

/** The longest side a copy is made at, then narrower until it fits. */
export const MAX_SENT_SIDE = 4096;
/** The most pixels the server makes thumbnails from (`MAX_DECODED_PIXELS` in `resize.ts`). */
export const MAX_SENT_PIXELS = 40_000_000;
const MIN_SENT_SIDE = 256;

/** Whether an image is sent as a smaller copy: over the byte cap, or more pixels than are read. */
export function needsShrinking(
	bytes: number,
	size: ImageSize | undefined,
	maxBytes: number,
): boolean {
	return bytes > maxBytes || (size !== undefined && size.width * size.height > MAX_SENT_PIXELS);
}

/** The sizes a copy is tried at, largest first, each keeping the image's shape. */
export function shrinkSteps({ width, height }: ImageSize): ImageSize[] {
	let steps: ImageSize[] = [];
	let longest = Math.max(width, height);
	for (
		let side = Math.min(longest, MAX_SENT_SIDE);
		side === Math.min(longest, MAX_SENT_SIDE) || side >= MIN_SENT_SIDE;
		side = Math.floor(side * 0.75)
	) {
		let scale = side / longest;
		steps.push({
			width: Math.max(1, Math.round(width * scale)),
			height: Math.max(1, Math.round(height * scale)),
		});
		if (side < MIN_SENT_SIDE) break;
	}
	return steps;
}

/** The name a copy is sent under: the same, with the extension of what it now is. */
export function shrunkName(name: string, type: string): string {
	let extension = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
	let stem = name.replace(/\.[a-z0-9]{1,5}$/i, "");
	return `${stem || "image"}.${extension}`;
}

export type Shrunk = { file: File; original: { bytes: number } & ImageSize };

/**
 * A copy of the image small enough to send, or undefined where it needs none or the browser cannot
 * decode it (the server then refuses it as it would have). A JPEG stays a JPEG; anything else
 * becomes a WebP, which keeps transparency.
 */
export async function shrinkImage(file: File, maxBytes: number): Promise<Shrunk | undefined> {
	let head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
	let size = rasterSize(head);
	if (!needsShrinking(file.size, size, maxBytes)) return undefined;
	let type = file.type === "image/jpeg" || head[0] === 0xff ? "image/jpeg" : "image/webp";
	let full: ImageSize = size ?? await createImageBitmap(file).then(bitmap => {
		let measured = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return measured;
	});
	for (let quality of [0.82, 0.7]) {
		for (let step of shrinkSteps(full)) {
			let bitmap = await createImageBitmap(file, {
				resizeWidth: step.width,
				resizeHeight: step.height,
				resizeQuality: "high",
			});
			let canvas = new OffscreenCanvas(step.width, step.height);
			canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
			bitmap.close();
			let blob = await canvas.convertToBlob({ type, quality });
			if (blob.size <= maxBytes) {
				return {
					file: new File([blob], shrunkName(file.name, blob.type), { type: blob.type }),
					original: { bytes: file.size, ...full },
				};
			}
		}
	}
	return undefined;
}
