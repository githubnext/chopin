/**
 * What a Chat message may carry: raster images and text-like files, known by their bytes.
 *
 * The browser checks a file before it is uploaded and the server checks it again on arrival, with
 * the same functions, so the two cannot disagree about what a file is. A name or a declared type
 * is only ever a claim to compare with what the bytes say; the bytes decide.
 */

export const ATTACHMENT_IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;
export type AttachmentImageType = (typeof ATTACHMENT_IMAGE_TYPES)[number];

/** Every text-like file is stored, served and given to a model as plain text. */
export const ATTACHMENT_TEXT_TYPE = "text/plain";

export type AttachmentKind = "image" | "file";

/** The caps in force: each is a server setting, and the browser is told them on joining. */
export type AttachmentLimits = {
	/** The most one file may be, in bytes. */
	maxBytes: number;
	/** The most files one message may carry. */
	maxCount: number;
	/** The most the files of one message may total, in bytes. */
	maxTotalBytes: number;
};

/** What the bytes of a file are, read from the bytes alone. */
export type Sniffed =
	| { kind: "image"; mimeType: AttachmentImageType }
	| { kind: "file"; mimeType: typeof ATTACHMENT_TEXT_TYPE };

/**
 * Why a file is refused, in the order it is found. `empty`, `too-large`, `unsupported` and
 * `image-type` are the file's own; `too-many` and `too-much` are the message's; `images-unavailable`
 * is what the document's model cannot read; the rest are what a browser reports of its own upload.
 */
export type AttachmentRefusal =
	| "empty"
	| "too-large"
	| "unsupported"
	| "image-type"
	| "too-many"
	| "too-much"
	| "images-unavailable"
	| "upload-failed"
	| "not-allowed"
	| "gone";

export type AttachmentCheck =
	| ({ ok: true } & Sniffed)
	| {
		ok: false;
		reason: Extract<AttachmentRefusal, "empty" | "too-large" | "unsupported" | "image-type">;
	};

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
	return bytes.length >= offset + prefix.length
		&& prefix.every((value, index) => bytes[offset + index] === value);
}

/** The raster image a file signature names. SVG is never one: it can carry script. */
export function sniffImage(bytes: Uint8Array): AttachmentImageType | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
	) {
		return "image/webp";
	}
	if (
		startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
		|| startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
	) return "image/gif";
	return undefined;
}

/** The control characters a text file may hold: tab, line feed, form feed, return and escape. */
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

/** Whether the bytes are UTF-8 text: valid, with no control character a text file never holds. */
export function sniffText(bytes: Uint8Array): boolean {
	for (let byte of bytes) {
		if (byte < 0x20 && !TEXT_CONTROLS.has(byte)) return false;
		if (byte === 0x7f) return false;
	}
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/** What the bytes are, or undefined for anything that is neither a supported image nor text. */
export function sniffAttachment(bytes: Uint8Array): Sniffed | undefined {
	let image = sniffImage(bytes);
	if (image) return { kind: "image", mimeType: image };
	if (bytes.byteLength > 0 && sniffText(bytes)) {
		return { kind: "file", mimeType: ATTACHMENT_TEXT_TYPE };
	}
	return undefined;
}

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"jfif",
	"webp",
	"gif",
	"svg",
	"svgz",
	"bmp",
	"ico",
	"avif",
	"heic",
	"heif",
	"tif",
	"tiff",
]);

function extension(name: string): string {
	let dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether the name or the declared type claims an image, whatever the bytes are. */
export function claimsImage(name: string, declaredType?: string): boolean {
	return !!declaredType?.toLowerCase().startsWith("image/")
		|| IMAGE_EXTENSIONS.has(extension(name));
}

/** The size check, which needs no bytes: an empty file and one over the per-file cap. */
export function checkAttachmentSize(
	size: number,
	limits: Pick<AttachmentLimits, "maxBytes">,
): "empty" | "too-large" | undefined {
	if (size <= 0) return "empty";
	if (size > limits.maxBytes) return "too-large";
	return undefined;
}

/**
 * One file as the server and the browser both judge it. A file that claims to be an image by its
 * name or declared type must be one of the supported rasters by its bytes: an HTML page named
 * `.png`, or an SVG, is refused rather than stored under a type it is not. Anything else is
 * accepted only as text, whatever it is called. What it is stored as is what its bytes say.
 */
export function checkAttachment(
	input: { name: string; type?: string; bytes: Uint8Array },
	limits: Pick<AttachmentLimits, "maxBytes">,
): AttachmentCheck {
	let size = checkAttachmentSize(input.bytes.byteLength, limits);
	if (size) return { ok: false, reason: size };
	let sniffed = sniffAttachment(input.bytes);
	if (claimsImage(input.name, input.type) && sniffed?.kind !== "image") {
		return { ok: false, reason: "image-type" };
	}
	if (!sniffed) return { ok: false, reason: "unsupported" };
	return { ok: true, ...sniffed };
}

/**
 * The message's own limits over the files it already carries and the one being added: the count,
 * then the total.
 */
export function checkMessageAttachments(
	sizes: readonly number[],
	limits: AttachmentLimits,
): "too-many" | "too-much" | undefined {
	if (sizes.length > limits.maxCount) return "too-many";
	if (sizes.reduce((sum, size) => sum + size, 0) > limits.maxTotalBytes) return "too-much";
	return undefined;
}

const NAME_LIMIT = 120;

/**
 * A file's name as it is kept: no folders, no control characters, no marks that change the way a
 * line reads, and at most 120 characters with its extension kept. A name that is nothing is a
 * plain word for the kind.
 */
export function attachmentName(raw: string, kind: AttachmentKind): string {
	let name = raw
		.replace(/^.*[\\/]/s, "")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	let characters = [...name];
	if (characters.length > NAME_LIMIT) {
		let dot = name.lastIndexOf(".");
		let ending = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
		name = `${characters.slice(0, NAME_LIMIT - [...ending].length).join("")}${ending}`;
	}
	return name || (kind === "image" ? "Image" : "File");
}

/** A size in words: `512 B`, `12 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	let kilobytes = bytes / 1024;
	if (kilobytes < 1024) {
		return `${kilobytes < 10 ? Math.round(kilobytes * 10) / 10 : Math.round(kilobytes)} KB`;
	}
	let megabytes = kilobytes / 1024;
	return `${Math.round(megabytes * 10) / 10} MB`;
}

/**
 * Why a file or message is refused, for the person who sent it: plain words that name the file
 * and what to do. None of Chopin's own terms appear in them.
 */
export function refusalText(
	reason: AttachmentRefusal,
	context: { name?: string; limits?: AttachmentLimits } = {},
): string {
	let name = context.name ? `${context.name} ` : "This file ";
	let { limits } = context;
	switch (reason) {
		case "empty":
			return `${name}is empty.`;
		case "too-large":
			return limits
				? `${name}is over the ${formatBytes(limits.maxBytes)} limit for a file.`
				: `${name}is too large.`;
		case "unsupported":
			return `${name}isn't an image (PNG, JPEG, WebP or GIF) or a text file.`;
		case "image-type":
			return `${name}isn't a PNG, JPEG, WebP or GIF image.`;
		case "too-many":
			return limits
				? `A message can carry up to ${limits.maxCount} files.`
				: "That is more files than a message can carry.";
		case "too-much":
			return limits
				? `The files in a message can total up to ${formatBytes(limits.maxTotalBytes)}.`
				: "Those files are more than a message can carry.";
		case "images-unavailable":
			return "This model can't read images. Send it as text, or to the room.";
		case "upload-failed":
			return `${name}didn't upload.`;
		case "not-allowed":
			return "You can't add files to this document.";
		case "gone":
			return `${name}is no longer available.`;
	}
}

/** Where a document's files are uploaded: by a person who can write to it. */
export function attachmentsPath(channelId: string): string {
	return `/api/channels/${encodeURIComponent(channelId)}/attachments`;
}

/** Where a stored file is read: for a person who can read the document it belongs to. */
export function attachmentPath(channelId: string, id: string): string {
	return `${attachmentsPath(channelId)}/${encodeURIComponent(id)}`;
}
