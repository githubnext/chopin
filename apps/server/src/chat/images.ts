import { toolContentSchema, toolImageSchema } from "@chopin/agent-link";
import { HOSTED_IMAGE_PATH } from "@chopin/dialect";

import { imageSize, isImageType } from "../images/format";

import type { Chat as Wire } from "@chopin/protocol";
import type { ImageType } from "../images/format";

export type ToolImage = {
	bytes: Uint8Array;
	mimeType: ImageType;
	width: number;
	height: number;
	alt?: string;
	caption?: string;
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function contentBlocks(output: unknown): unknown[] | undefined {
	if (typeof output === "string") {
		try {
			output = JSON.parse(output);
		} catch {
			return undefined;
		}
	}
	return toolContentSchema.safeParse(output).data?.content;
}

function isImageBlock(block: unknown): boolean {
	return (block as { type?: unknown } | null)?.type === "image";
}

function hosted(block: unknown): ToolImage | undefined {
	let image = toolImageSchema.safeParse(block).data;
	if (!image || !isImageType(image.mimeType)) return undefined;
	let data = image.data.replace(/\s+/g, "");
	if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
	let bytes = new Uint8Array(Buffer.from(data, "base64"));
	let size = imageSize(image.mimeType, bytes);
	if (!size) return undefined;
	return {
		bytes,
		mimeType: image.mimeType,
		...size,
		...(image.alt === undefined ? {} : { alt: image.alt }),
		...(image.caption === undefined ? {} : { caption: image.caption }),
	};
}

export function toolImages(output: unknown): { images: ToolImage[]; refused: number } {
	let blocks = (contentBlocks(output) ?? []).filter(isImageBlock);
	let images = blocks.flatMap(block => hosted(block) ?? []);
	return { images, refused: blocks.length - images.length };
}

const IMAGE_KEYS = new Set(["src", "alt", "caption", "width", "height", "generated"]);

function pixels(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function savedImages(value: unknown): value is Wire.Image[] {
	return Array.isArray(value) && value.every(image => {
		if (!image || typeof image !== "object" || Array.isArray(image)) return false;
		let { src, alt, caption, width, height, generated } = image as Record<string, unknown>;
		return Object.keys(image).every(key => IMAGE_KEYS.has(key))
			&& typeof src === "string" && HOSTED_IMAGE_PATH.test(src)
			&& (alt === undefined || typeof alt === "string")
			&& (caption === undefined || typeof caption === "string")
			&& pixels(width) && pixels(height)
			&& (generated === undefined || generated === true);
	});
}

export function toolRowOutput(output: unknown): unknown {
	let blocks = contentBlocks(output) ?? [];
	let images = blocks.filter(isImageBlock).length;
	if (!images) return output;
	let lines = blocks.flatMap(block => {
		let { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
		return type === "text" && typeof text === "string" ? [text] : [];
	});
	return [...lines, images === 1 ? "1 image" : `${images} images`].join("\n");
}
