import { MAX_LINK_MESSAGE_BYTES, toolContentSchema, toolImageSchema } from "@chopin/agent-link";
import { HOSTED_IMAGE_PATH } from "@chopin/dialect";

import {
	DEFAULT_STORED_IMAGE_BYTES,
	IMAGE_LABELS,
	imageSize,
	namedImageType,
	sniffImageType,
} from "../images/format";

import type { Chat as Wire } from "@chopin/protocol";
import type { HostedImageType } from "../images/format";

export type ToolImage = {
	bytes: Uint8Array;
	mimeType: HostedImageType;
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

const TYPE_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const SHOWN = Object.values(IMAGE_LABELS).join(", ").replace(/, ([^,]+)$/, " or $1");

const REFUSAL_START = "Image couldn't be shown: ";

export const STORE_REFUSAL = `${REFUSAL_START}Chopin couldn't store it.`;

export function headerRefusal(type: HostedImageType): string {
	return `${REFUSAL_START}its ${
		IMAGE_LABELS[type]
	} header can't be read, so the image is cut short or damaged.`;
}

function refusal(reason: string): { reason: string } {
	return { reason: `${REFUSAL_START}${reason}` };
}

const TOO_LARGE = /^Image too large to show \(\d+(\.\d)? MB, limit \d+(\.\d)? MB\)$/;

function megabytes(bytes: number, round = Math.round): string {
	let size = round(bytes * 10 / 1_048_576) / 10;
	return Number.isInteger(size) ? `${size}` : size.toFixed(1);
}

function decodedBytes(data: string): number {
	let padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length - padding) * 3 / 4);
}

function typeNamed(declared: string): string {
	let name = declared.split(";")[0]!.trim().toLowerCase();
	return TYPE_TOKEN.test(name) ? ` ${name}` : "";
}

function hosted(block: unknown, maxBytes: number): ToolImage | { reason: string } {
	let image = toolImageSchema.safeParse(block).data;
	if (!image) return refusal("its block has no base64 data or no type.");
	if (image.tooLarge !== undefined) {
		return refusal(
			`it is ${megabytes(image.tooLarge)} MiB, which did not fit in one agent connection message (${
				megabytes(MAX_LINK_MESSAGE_BYTES)
			} MiB at most).`,
		);
	}
	let named = namedImageType(image.mimeType);
	if (!named) {
		return refusal(`its type${typeNamed(image.mimeType)} isn't one Chat shows (${SHOWN}).`);
	}
	let data = image.data.replace(/\s+/g, "");
	let size = decodedBytes(data);
	if (size > maxBytes) {
		return {
			reason: `Image too large to show (${megabytes(size, Math.ceil)} MB, limit ${
				megabytes(maxBytes, Math.floor)
			} MB)`,
		};
	}
	let leftover = data.length % 4;
	if (!BASE64.test(data) || (data.endsWith("=") ? leftover !== 0 : leftover === 1)) {
		return refusal("its data isn't valid base64.");
	}
	let bytes = new Uint8Array(Buffer.from(data, "base64"));
	let actual = sniffImageType(bytes);
	if (actual !== named) {
		return refusal(
			actual
				? `its bytes are ${IMAGE_LABELS[actual]} data, not ${IMAGE_LABELS[named]} as its type says.`
				: `its bytes aren't ${IMAGE_LABELS[named]} data, as its type says.`,
		);
	}
	let dimensions = imageSize(named, bytes);
	if (!dimensions) return { reason: headerRefusal(named) };
	return {
		bytes,
		mimeType: named,
		...dimensions,
		...(image.alt === undefined ? {} : { alt: image.alt }),
		...(image.caption === undefined ? {} : { caption: image.caption }),
	};
}

export function inspectImages(
	output: unknown,
	maxBytes = DEFAULT_STORED_IMAGE_BYTES,
): { images: ToolImage[]; refusals: Wire.ImageRefusal[] } {
	let images: ToolImage[] = [];
	let refusals: Wire.ImageRefusal[] = [];
	for (let block of (contentBlocks(output) ?? []).filter(isImageBlock)) {
		let found = hosted(block, maxBytes);
		if ("reason" in found) refusals.push({ before: images.length, reason: found.reason });
		else images.push(found);
	}
	return { images, refusals };
}

export function toolImages(
	output: unknown,
	maxBytes = DEFAULT_STORED_IMAGE_BYTES,
): { images: ToolImage[]; refused: number } {
	let { images, refusals } = inspectImages(output, maxBytes);
	return { images, refused: refusals.length };
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

const REFUSAL_KEYS = new Set(["before", "reason"]);

export function savedRefusals(value: unknown): value is Wire.ImageRefusal[] {
	return Array.isArray(value) && value.every(refusal => {
		if (!refusal || typeof refusal !== "object" || Array.isArray(refusal)) return false;
		let { before, reason } = refusal as Record<string, unknown>;
		return Object.keys(refusal).every(key => REFUSAL_KEYS.has(key))
			&& typeof before === "number" && Number.isSafeInteger(before) && before >= 0
			&& typeof reason === "string" && (reason.startsWith(REFUSAL_START) || TOO_LARGE.test(reason));
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
