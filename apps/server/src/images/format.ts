/**
 * Raster images Chopin hosts for its documents. Never SVG: an image served
 * from the application's own origin must not be able to carry script.
 */

export const MAX_IMAGE_BYTES = 1_048_576;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const HOSTED_IMAGE_TYPES = [
	...IMAGE_TYPES,
	"image/avif",
	"image/bmp",
	"image/x-icon",
] as const;
export type HostedImageType = (typeof HOSTED_IMAGE_TYPES)[number];

const EXTENSIONS: Record<HostedImageType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/x-icon": "ico",
};

const NAMES: Record<HostedImageType, readonly string[]> = {
	"image/png": ["image/png", "image/apng", "image/x-png"],
	"image/jpeg": ["image/jpeg", "image/jpg", "image/pjpeg"],
	"image/webp": ["image/webp"],
	"image/gif": ["image/gif"],
	"image/avif": ["image/avif"],
	"image/bmp": ["image/bmp", "image/x-bmp", "image/x-ms-bmp"],
	"image/x-icon": ["image/x-icon", "image/vnd.microsoft.icon", "image/ico"],
};

/** The `/images/` file name that serves a stored image of this type. */
export const HOSTED_IMAGE_FILE = /^([0-9a-f]{64})\.(png|jpg|jpeg|webp|gif|avif|bmp|ico)$/;

export function isImageType(value: unknown): value is ImageType {
	return IMAGE_TYPES.includes(value as ImageType);
}

export function imagePath(sha256: string, type: HostedImageType): string {
	return `/images/${sha256}.${EXTENSIONS[type]}`;
}

/** The stored type a file name extension may serve. */
export function extensionType(extension: string): HostedImageType | undefined {
	if (extension === "jpeg") return "image/jpeg";
	return HOSTED_IMAGE_TYPES.find(type => EXTENSIONS[type] === extension);
}

export function sniffImageType(bytes: Uint8Array): HostedImageType | undefined {
	return HOSTED_IMAGE_TYPES.find(type => matchesSignature(type, bytes));
}

export function declaredImageType(
	declared: string,
	bytes: Uint8Array,
): HostedImageType | undefined {
	let type = sniffImageType(bytes);
	let name = declared.split(";")[0]!.trim().toLowerCase();
	return type && NAMES[type].includes(name) ? type : undefined;
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

function bmpSize(bytes: Uint8Array): ImageSize | undefined {
	if (littleEndian(bytes, 14, 4) === 12) {
		return { width: littleEndian(bytes, 18, 2), height: littleEndian(bytes, 20, 2) };
	}
	return {
		width: littleEndian(bytes, 18, 4) | 0,
		height: Math.abs(littleEndian(bytes, 22, 4) | 0),
	};
}

function icoSize(bytes: Uint8Array): ImageSize | undefined {
	let entries = littleEndian(bytes, 4, 2);
	if (6 + entries * 16 > bytes.length) return undefined;
	let largest: ImageSize | undefined;
	for (let index = 0; index < entries; index++) {
		let at = 6 + index * 16;
		let size = { width: bytes[at]! || 256, height: bytes[at + 1]! || 256 };
		if (!largest || size.width * size.height > largest.width * largest.height) largest = size;
	}
	return largest;
}

type Box = { type: string; body: number; end: number };

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
	let found: Box[] = [];
	for (let at = start; at + 8 <= end;) {
		let size = bigEndian(bytes, at, 4);
		if (size < 8 || at + size > end) break;
		found.push({
			type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
			body: at + 8,
			end: at + size,
		});
		at += size;
	}
	return found;
}

function avifSize(bytes: Uint8Array): ImageSize | undefined {
	let meta = boxes(bytes, 0, bytes.length).find(box => box.type === "meta");
	if (!meta) return undefined;
	let children = boxes(bytes, meta.body + 4, meta.end);
	let primary = children.find(box => box.type === "pitm");
	let container = children.find(box => box.type === "iprp");
	if (!primary || !container) return undefined;
	let item = bigEndian(bytes, primary.body + 4, bytes[primary.body] ? 4 : 2);
	let inside = boxes(bytes, container.body, container.end);
	let properties = inside.find(box => box.type === "ipco");
	let associations = inside.find(box => box.type === "ipma");
	if (!properties || !associations) return undefined;
	let listed = boxes(bytes, properties.body, properties.end);
	let indexBytes = (bytes[associations.body + 3] ?? 0) & 1 ? 2 : 1;
	let idBytes = bytes[associations.body] ? 4 : 2;
	let at = associations.body + 8;
	for (
		let entries = bigEndian(bytes, associations.body + 4, 4);
		entries-- > 0 && at + idBytes + 1 <= associations.end;
	) {
		let id = bigEndian(bytes, at, idBytes);
		let count = bytes[at + idBytes]!;
		let own: Box[] = [];
		at += idBytes + 1;
		for (; count-- > 0 && at + indexBytes <= associations.end; at += indexBytes) {
			let index = bigEndian(bytes, at, indexBytes) & (indexBytes === 2 ? 0x7fff : 0x7f);
			let property = listed[index - 1];
			if (id === item && property) own.push(property);
		}
		if (id !== item) continue;
		let extent = own.find(property => property.type === "ispe");
		if (!extent || extent.end - extent.body < 12) return undefined;
		let rotation = own.find(property => property.type === "irot");
		if (rotation && rotation.end - rotation.body < 1) return undefined;
		let width = bigEndian(bytes, extent.body + 4, 4);
		let height = bigEndian(bytes, extent.body + 8, 4);
		return rotation && (bytes[rotation.body]! & 1) === 1
			? { width: height, height: width }
			: { width, height };
	}
	return undefined;
}

export function imageSize(type: HostedImageType, bytes: Uint8Array): ImageSize | undefined {
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
		case "image/bmp":
			size = bmpSize(bytes);
			break;
		case "image/x-icon":
			size = icoSize(bytes);
			break;
		case "image/avif":
			size = avifSize(bytes);
			break;
	}
	return size && size.width > 0 && size.height > 0 ? size : undefined;
}

function avif(bytes: Uint8Array): boolean {
	if (!ascii(bytes, 4, "ftyp")) return false;
	let end = Math.min(bigEndian(bytes, 0, 4), bytes.length);
	for (let offset = 8; offset + 4 <= end; offset += offset === 8 ? 8 : 4) {
		let brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		if (brand === "avif" || brand === "avis") return true;
	}
	return false;
}

/** Whether the bytes' file signature is the declared type's. */
export function matchesSignature(type: HostedImageType, bytes: Uint8Array): boolean {
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
		case "image/avif":
			return avif(bytes);
		case "image/bmp":
			return ascii(bytes, 0, "BM")
				&& [12, 40, 52, 56, 64, 108, 124].includes(littleEndian(bytes, 14, 4));
		case "image/x-icon":
			return startsWith(bytes, [0, 0, 1, 0]) && littleEndian(bytes, 4, 2) > 0;
	}
}
