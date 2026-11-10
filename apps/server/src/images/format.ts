/**
 * Raster images Chopin hosts for its documents. Never SVG: an image served
 * from the application's own origin must not be able to carry script.
 */

export const MAX_IMAGE_BYTES = 1_048_576;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

const EXTENSIONS: Record<ImageType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** The `/images/` file name that serves a stored image of this type. */
export const HOSTED_IMAGE_FILE = /^([0-9a-f]{64})\.(png|jpg|jpeg|webp|gif)$/;

export function isImageType(value: unknown): value is ImageType {
	return IMAGE_TYPES.includes(value as ImageType);
}

export function imagePath(sha256: string, type: ImageType): string {
	return `/images/${sha256}.${EXTENSIONS[type]}`;
}

/** The stored type a file name extension may serve. */
export function extensionType(extension: string): ImageType | undefined {
	if (extension === "jpeg") return "image/jpeg";
	return IMAGE_TYPES.find(type => EXTENSIONS[type] === extension);
}

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
	return bytes.length >= offset + prefix.length
		&& prefix.every((value, index) => bytes[offset + index] === value);
}

export type ImageSize = { width: number; height: number };

function bigEndian(bytes: Uint8Array, offset: number, length: number): number {
	let value = 0;
	for (let index = 0; index < length; index++) value = value * 256 + bytes[offset + index]!;
	return value;
}

function littleEndian(bytes: Uint8Array, offset: number, length: number): number {
	let value = 0;
	for (let index = length - 1; index >= 0; index--) value = value * 256 + bytes[offset + index]!;
	return value;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
	return startsWith(bytes, [...text].map(letter => letter.charCodeAt(0)), offset);
}

function quarterTurned(bytes: Uint8Array, start: number, end: number): boolean {
	if (!ascii(bytes, start, "Exif\0\0")) return false;
	let tiff = start + 6;
	let little = ascii(bytes, tiff, "II");
	if (!little && !ascii(bytes, tiff, "MM")) return false;
	let read = (offset: number, length: number) =>
		offset + length > end
			? undefined
			: little
			? littleEndian(bytes, offset, length)
			: bigEndian(bytes, offset, length);
	let directory = read(tiff + 4, 4);
	if (directory === undefined) return false;
	let entries = read(tiff + directory, 2) ?? 0;
	for (let index = 0; index < entries; index++) {
		let entry = tiff + directory + 2 + index * 12;
		if (read(entry, 2) !== 0x0112) continue;
		let orientation = read(entry + 8, 2);
		return orientation !== undefined && orientation >= 5 && orientation <= 8;
	}
	return false;
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
	let offset = 2;
	let turned = false;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		let marker = bytes[offset + 1]!;
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined;
		let length = bigEndian(bytes, offset + 2, 2);
		if (length < 2) return undefined;
		if (marker === 0xe1) turned ||= quarterTurned(bytes, offset + 4, offset + 2 + length);
		let frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8
			&& marker !== 0xcc;
		if (frame) {
			if (offset + 9 > bytes.length) return undefined;
			let height = bigEndian(bytes, offset + 5, 2);
			let width = bigEndian(bytes, offset + 7, 2);
			return turned ? { width: height, height: width } : { width, height };
		}
		offset += 2 + length;
	}
	return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
	if (ascii(bytes, 12, "VP8 ") && bytes.length >= 30) {
		if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
		return {
			width: littleEndian(bytes, 26, 2) & 0x3fff,
			height: littleEndian(bytes, 28, 2) & 0x3fff,
		};
	}
	if (ascii(bytes, 12, "VP8L") && bytes.length >= 25) {
		if (bytes[20] !== 0x2f) return undefined;
		let bits = littleEndian(bytes, 21, 4);
		return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) & 0x3fff) + 1 };
	}
	if (ascii(bytes, 12, "VP8X") && bytes.length >= 30) {
		return { width: littleEndian(bytes, 24, 3) + 1, height: littleEndian(bytes, 27, 3) + 1 };
	}
	return undefined;
}

export function imageSize(type: ImageType, bytes: Uint8Array): ImageSize | undefined {
	if (!matchesSignature(type, bytes)) return undefined;
	let size: ImageSize | undefined;
	switch (type) {
		case "image/png":
			size = bytes.length >= 24 && ascii(bytes, 12, "IHDR")
				? { width: bigEndian(bytes, 16, 4), height: bigEndian(bytes, 20, 4) }
				: undefined;
			break;
		case "image/gif":
			size = bytes.length >= 10
				? { width: littleEndian(bytes, 6, 2), height: littleEndian(bytes, 8, 2) }
				: undefined;
			break;
		case "image/jpeg":
			size = jpegSize(bytes);
			break;
		case "image/webp":
			size = webpSize(bytes);
			break;
	}
	return size && size.width > 0 && size.height > 0 ? size : undefined;
}

/** Whether the bytes' file signature is the declared type's. */
export function matchesSignature(type: ImageType, bytes: Uint8Array): boolean {
	switch (type) {
		case "image/png":
			return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case "image/jpeg":
			return startsWith(bytes, [0xff, 0xd8, 0xff]);
		case "image/webp":
			return startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
				&& startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
		case "image/gif":
			return startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
				|| startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
	}
}
