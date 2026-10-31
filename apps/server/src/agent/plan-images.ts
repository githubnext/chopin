import { prepareImage } from "../mcp/image";

import type { ImageType } from "../images/format";

/** The longest alternative text a Planner may give an image, in characters. */
export const MAX_ALT_LENGTH = 200;

export type PlanImage = { bytes: Uint8Array; mimeType: ImageType; alt: string };

const REFUSALS = {
	"too-large": "The image is larger than 1 MiB. Make it smaller, or use a JPEG or WebP.",
	"unsupported-type": "Only PNG, JPEG, WebP and GIF images can be stored.",
	"signature-mismatch": "The bytes are not the image type given as mimeType.",
} as const;

/** What an image's alternative text becomes inside `![…](…)`: one line, nothing that ends it early. */
export function altText(value: string): string {
	return value.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, "\\$&");
}

/**
 * Validate `upload_plan_image` arguments. The document is the Planner's own, so the image is not
 * given a document; the bytes get the same checks `upload_image` makes.
 */
export function planImage(raw: unknown, document: string): PlanImage {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("upload_plan_image arguments must be an object");
	}
	let args = raw as Record<string, unknown>;
	let fields = Object.keys(args).sort().join(",");
	if (fields !== "alt,data,mimeType") {
		throw new Error("upload_plan_image takes exactly data (base64), mimeType and alt");
	}
	if (typeof args.alt !== "string" || !args.alt.trim()) {
		throw new Error("alt is required: say what the image shows, in a sentence");
	}
	let alt = altText(args.alt);
	if (alt.length > MAX_ALT_LENGTH) throw new Error(`alt exceeds ${MAX_ALT_LENGTH} characters`);
	let prepared = prepareImage({ id: document, data: args.data, mimeType: args.mimeType });
	if (!prepared) throw new Error("data must be standard base64 and mimeType an image type");
	if ("refusal" in prepared) throw new Error(REFUSALS[prepared.refusal]);
	return { bytes: prepared.input.bytes, mimeType: prepared.input.mimeType, alt };
}
