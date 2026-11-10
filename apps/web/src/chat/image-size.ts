import { rasterType, text } from "./local-image";

export type ImageSize = { width: number; height: number };

const ADDRESS_CHARS_READ = 96 * 1024;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ASCII_WHITE_SPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const PERCENT_SIGN = 0x25;
const BASE64_PADDING = 0x3d;

const PNG_FIRST_CHUNK_END = 33;
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_HEADER_BYTES = 8;

const EXIF_ORIENTATION_TAG = 0x0112;
const EXIF_X_RESOLUTION_TAG = 0x011a;
const EXIF_Y_RESOLUTION_TAG = 0x011b;
const EXIF_RESOLUTION_UNIT_TAG = 0x0128;
const EXIF_SUB_DIRECTORY_TAG = 0x8769;
const EXIF_PIXEL_WIDTH_TAG = 0xa002;
const EXIF_PIXEL_HEIGHT_TAG = 0xa003;
const EXIF_INCH_UNIT = 2;
const EXIF_REFERENCE_DOTS_PER_INCH = 72;
const TIFF_MAGIC_NUMBER = 42;
const TIFF_ENTRY_BYTES = 12;
const TIFF_SHORT_TYPE = 3;
const TIFF_LONG_TYPE = 4;
const TIFF_RATIONAL_TYPE = 5;
const FIRST_QUARTER_TURN_ORIENTATION = 5;
const LAST_QUARTER_TURN_ORIENTATION = 8;
const FIRST_ORIENTATION = 1;

const JPEG_PADDING_MARKER = 0xff;
const JPEG_STANDALONE_MARKER = 0x01;
const JPEG_RESTART_FIRST_MARKER = 0xd0;
const JPEG_START_OF_IMAGE_MARKER = 0xd8;
const JPEG_END_OF_IMAGE_MARKER = 0xd9;
const JPEG_START_OF_SCAN_MARKER = 0xda;
const JPEG_BASELINE_FRAME_MARKER = 0xc0;
const JPEG_PROGRESSIVE_FRAME_MARKER = 0xc2;
const JPEG_EXIF_SEGMENT_MARKER = 0xe1;

const GIF_HEADER_BYTES = 13;
const GIF_IMAGE_DESCRIPTOR_BYTES = 10;
const GIF_IMAGE_SEPARATOR = 0x2c;
const GIF_EXTENSION_INTRODUCER = 0x21;

const BMP_CORE_HEADER_BYTES = 12;

const ICO_DIRECTORY_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_ENTRY_SIDE_WHEN_ZERO = 256;

const BOX_HEADER_BYTES = 8;
const AVIF_EXTENT_BODY_BYTES = 12;

type Box = { type: string; body: number; end: number };

type ExifFacts = {
	quarterTurn: boolean;
	resolution?: { x: number; y: number };
	unit?: number;
	pixels?: ImageSize;
};

function dataPayloadStart(src: string): Uint8Array | undefined {
	let comma = src.slice(0, 128).indexOf(",");
	if (comma < 0 || !/^data:/i.test(src)) return undefined;
	let payload = src.slice(comma + 1, comma + 1 + ADDRESS_CHARS_READ);
	let unescaped: number[] = [];
	for (let at = 0; at < payload.length; at++) {
		let code = payload.charCodeAt(at);
		let escapedByte = code === PERCENT_SIGN ? payload.slice(at + 1, at + 3) : "";
		if (/^[0-9a-f]{2}$/i.test(escapedByte)) {
			unescaped.push(parseInt(escapedByte, 16));
			at += 2;
		} else if (code < 0x80) unescaped.push(code);
		else return undefined;
	}
	if (!/;\s*base64\s*$/i.test(src.slice(0, comma))) return Uint8Array.from(unescaped);
	let bytes: number[] = [];
	let pending = 0;
	let pendingBits = 0;
	for (let code of unescaped) {
		if (ASCII_WHITE_SPACE.has(code)) continue;
		if (code === BASE64_PADDING) break;
		let sextet = BASE64_ALPHABET.indexOf(String.fromCharCode(code));
		if (sextet < 0) return undefined;
		pending = (pending << 6) | sextet;
		pendingBits += 6;
		if (pendingBits >= 8) {
			pendingBits -= 8;
			bytes.push((pending >> pendingBits) & 0xff);
			pending &= (1 << pendingBits) - 1;
		}
	}
	return Uint8Array.from(bytes);
}

function readUnsigned(
	bytes: Uint8Array,
	offset: number,
	length: number,
	littleEndian: boolean,
): number {
	let value = 0;
	for (let index = 0; index < length; index++) {
		let byte = bytes[offset + (littleEndian ? length - 1 - index : index)];
		if (byte === undefined) return Number.NaN;
		value = value * 256 + byte;
	}
	return value;
}

function sizeWhenPositive(width: number, height: number): ImageSize | undefined {
	return width > 0 && height > 0 ? { width, height } : undefined;
}

function withSidesExchangedWhen(
	size: ImageSize | undefined,
	exchanged: boolean,
): ImageSize | undefined {
	return size && exchanged ? { width: size.height, height: size.width } : size;
}

function readExif(bytes: Uint8Array, start: number, end: number): ExifFacts {
	let facts: ExifFacts = { quarterTurn: false };
	let littleEndian = text(bytes, start, "II") ? true : text(bytes, start, "MM") ? false : undefined;
	if (
		littleEndian === undefined || end > bytes.length
		|| readUnsigned(bytes, start + 2, 2, littleEndian) !== TIFF_MAGIC_NUMBER
	) return facts;
	let oriented = false;
	let pixelWidth: number | undefined;
	let pixelHeight: number | undefined;
	let subDirectory: number | undefined;
	let readNumber = (entry: number): number | undefined => {
		let type = readUnsigned(bytes, entry + 2, 2, littleEndian);
		if (readUnsigned(bytes, entry + 4, 4, littleEndian) !== 1) return undefined;
		let value = type === TIFF_SHORT_TYPE
			? readUnsigned(bytes, entry + 8, 2, littleEndian)
			: type === TIFF_LONG_TYPE
			? readUnsigned(bytes, entry + 8, 4, littleEndian)
			: Number.NaN;
		return Number.isNaN(value) ? undefined : value;
	};
	let readShort = (entry: number): number | undefined =>
		readUnsigned(bytes, entry + 2, 2, littleEndian) === TIFF_SHORT_TYPE
			? readNumber(entry)
			: undefined;
	let readRational = (entry: number): number | undefined => {
		let valid = readUnsigned(bytes, entry + 2, 2, littleEndian) === TIFF_RATIONAL_TYPE
			&& readUnsigned(bytes, entry + 4, 4, littleEndian) === 1;
		let at = start + readUnsigned(bytes, entry + 8, 4, littleEndian);
		let numerator = readUnsigned(bytes, at, 4, littleEndian);
		let denominator = readUnsigned(bytes, at + 4, 4, littleEndian);
		return valid && at + 8 <= end && denominator > 0 && numerator > 0
			? numerator / denominator
			: undefined;
	};
	let readDirectory = (directory: number, first: boolean) => {
		let entries = readUnsigned(bytes, directory, 2, littleEndian);
		for (
			let entry = directory + 2;
			entries-- > 0 && entry + TIFF_ENTRY_BYTES <= end;
			entry += TIFF_ENTRY_BYTES
		) {
			let tag = readUnsigned(bytes, entry, 2, littleEndian);
			if (first && tag === EXIF_ORIENTATION_TAG && !oriented) {
				let orientation = readShort(entry);
				if (orientation !== undefined && orientation >= FIRST_ORIENTATION && orientation <= 8) {
					oriented = true;
					facts.quarterTurn = orientation >= FIRST_QUARTER_TURN_ORIENTATION
						&& orientation <= LAST_QUARTER_TURN_ORIENTATION;
				}
			} else if (first && tag === EXIF_X_RESOLUTION_TAG) {
				facts.resolution = {
					x: readRational(entry) ?? facts.resolution?.x ?? 0,
					y: facts.resolution?.y ?? 0,
				};
			} else if (first && tag === EXIF_Y_RESOLUTION_TAG) {
				facts.resolution = {
					x: facts.resolution?.x ?? 0,
					y: readRational(entry) ?? facts.resolution?.y ?? 0,
				};
			} else if (first && tag === EXIF_RESOLUTION_UNIT_TAG) {
				facts.unit ??= readShort(entry);
			} else if (first && tag === EXIF_SUB_DIRECTORY_TAG) {
				subDirectory ??= readNumber(entry);
			} else if (tag === EXIF_PIXEL_WIDTH_TAG) {
				pixelWidth ??= readNumber(entry);
			} else if (tag === EXIF_PIXEL_HEIGHT_TAG) {
				pixelHeight ??= readNumber(entry);
			}
		}
	};
	readDirectory(start + readUnsigned(bytes, start + 4, 4, littleEndian), true);
	if (subDirectory !== undefined) readDirectory(start + subDirectory, false);
	if (pixelWidth !== undefined && pixelHeight !== undefined) {
		facts.pixels = { width: pixelWidth, height: pixelHeight };
	}
	return facts;
}

function densityMayCorrect(facts: ExifFacts, size: ImageSize): boolean {
	let { resolution, unit, pixels } = facts;
	if (!resolution?.x || !resolution.y || unit !== EXIF_INCH_UNIT || !pixels) return false;
	if (pixels.width === size.width && pixels.height === size.height) return false;
	return Math.abs(pixels.width - size.width * EXIF_REFERENCE_DOTS_PER_INCH / resolution.x) <= 1
		&& Math.abs(pixels.height - size.height * EXIF_REFERENCE_DOTS_PER_INCH / resolution.y) <= 1;
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
	if (!text(bytes, 12, "IHDR")) return undefined;
	let size = sizeWhenPositive(readUnsigned(bytes, 16, 4, false), readUnsigned(bytes, 20, 4, false));
	let quarterTurn = false;
	let exifSeen = false;
	for (
		let chunk = PNG_FIRST_CHUNK_END;
		chunk + PNG_CHUNK_HEADER_BYTES <= bytes.length;
		chunk += PNG_CHUNK_OVERHEAD + readUnsigned(bytes, chunk, 4, false)
	) {
		if (text(bytes, chunk + 4, "IDAT") || text(bytes, chunk + 4, "IEND")) {
			return withSidesExchangedWhen(size, quarterTurn);
		}
		if (text(bytes, chunk + 4, "eXIf") && !exifSeen) {
			exifSeen = true;
			quarterTurn = readExif(
				bytes,
				chunk + PNG_CHUNK_HEADER_BYTES,
				chunk + PNG_CHUNK_HEADER_BYTES + readUnsigned(bytes, chunk, 4, false),
			).quarterTurn;
		}
	}
	return undefined;
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
	let size: ImageSize | undefined;
	let exif: ExifFacts | undefined;
	for (let at = 2; at + 4 <= bytes.length;) {
		if (bytes[at] !== JPEG_PADDING_MARKER) return undefined;
		let marker = bytes[at + 1]!;
		if (marker === JPEG_PADDING_MARKER) at += 1;
		else if (
			marker === JPEG_STANDALONE_MARKER
			|| (marker >= JPEG_RESTART_FIRST_MARKER && marker <= JPEG_START_OF_IMAGE_MARKER)
		) at += 2;
		else if (marker === JPEG_END_OF_IMAGE_MARKER) return undefined;
		else if (marker === JPEG_START_OF_SCAN_MARKER) {
			if (!size) return undefined;
			if (exif && densityMayCorrect(exif, size)) return undefined;
			return withSidesExchangedWhen(size, exif?.quarterTurn === true);
		} else {
			let segmentLength = readUnsigned(bytes, at + 2, 2, false);
			if (!(segmentLength >= 2)) return undefined;
			if (marker >= JPEG_BASELINE_FRAME_MARKER && marker <= JPEG_PROGRESSIVE_FRAME_MARKER) {
				if (at + 9 > bytes.length) return undefined;
				size ??= sizeWhenPositive(
					readUnsigned(bytes, at + 7, 2, false),
					readUnsigned(bytes, at + 5, 2, false),
				);
				if (!size) return undefined;
			}
			if (marker === JPEG_EXIF_SEGMENT_MARKER && text(bytes, at + 4, "Exif\0\0") && !exif) {
				exif = readExif(bytes, at + 10, at + 2 + segmentLength);
			}
			at += 2 + segmentLength;
		}
	}
	return undefined;
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
	let packedFields = bytes[10] ?? 0;
	let globalColorTableBytes = packedFields & 0x80 ? 3 * 2 ** ((packedFields & 7) + 1) : 0;
	for (let at = GIF_HEADER_BYTES + globalColorTableBytes; at < bytes.length; at += 1) {
		if (bytes[at] === GIF_IMAGE_SEPARATOR) {
			if (at + GIF_IMAGE_DESCRIPTOR_BYTES > bytes.length) return undefined;
			let frameRight = readUnsigned(bytes, at + 1, 2, true) + readUnsigned(bytes, at + 5, 2, true);
			let frameBottom = readUnsigned(bytes, at + 3, 2, true) + readUnsigned(bytes, at + 7, 2, true);
			return sizeWhenPositive(
				Math.max(readUnsigned(bytes, 6, 2, true), frameRight),
				Math.max(readUnsigned(bytes, 8, 2, true), frameBottom),
			);
		}
		if (bytes[at] !== GIF_EXTENSION_INTRODUCER) return undefined;
		for (at += 2; (bytes[at] ?? 0) > 0; at += bytes[at]! + 1);
	}
	return undefined;
}

function bmpSize(bytes: Uint8Array): ImageSize | undefined {
	if (readUnsigned(bytes, 14, 4, true) === BMP_CORE_HEADER_BYTES) {
		return sizeWhenPositive(readUnsigned(bytes, 18, 2, true), readUnsigned(bytes, 20, 2, true));
	}
	return sizeWhenPositive(
		readUnsigned(bytes, 18, 4, true) | 0,
		Math.abs(readUnsigned(bytes, 22, 4, true) | 0),
	);
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
	if (
		text(bytes, 12, "VP8 ") && bytes.length >= 30 && readUnsigned(bytes, 23, 3, false) === 0x9d012a
	) {
		return sizeWhenPositive(
			readUnsigned(bytes, 26, 2, true) & 0x3fff,
			readUnsigned(bytes, 28, 2, true) & 0x3fff,
		);
	}
	if (text(bytes, 12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
		let packedSides = readUnsigned(bytes, 21, 4, true);
		return sizeWhenPositive((packedSides & 0x3fff) + 1, ((packedSides >>> 14) & 0x3fff) + 1);
	}
	if (text(bytes, 12, "VP8X") && bytes.length >= 30) {
		return sizeWhenPositive(
			readUnsigned(bytes, 24, 3, true) + 1,
			readUnsigned(bytes, 27, 3, true) + 1,
		);
	}
	return undefined;
}

function icoSize(bytes: Uint8Array): ImageSize | undefined {
	let entries = readUnsigned(bytes, 4, 2, true);
	if (ICO_DIRECTORY_BYTES + entries * ICO_ENTRY_BYTES > bytes.length) return undefined;
	let largest: ImageSize | undefined;
	let largestTiedInAreaWithAnotherShape = false;
	for (let entry = 0; entry < entries; entry++) {
		let at = ICO_DIRECTORY_BYTES + entry * ICO_ENTRY_BYTES;
		let width = bytes[at]! || ICO_ENTRY_SIDE_WHEN_ZERO;
		let height = bytes[at + 1]! || ICO_ENTRY_SIDE_WHEN_ZERO;
		let largestArea = largest ? largest.width * largest.height : 0;
		if (width * height > largestArea) {
			largest = { width, height };
			largestTiedInAreaWithAnotherShape = false;
		} else if (
			width * height === largestArea && (width !== largest!.width || height !== largest!.height)
		) largestTiedInAreaWithAnotherShape = true;
	}
	return largestTiedInAreaWithAnotherShape ? undefined : largest;
}

function wholeBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
	let found: Box[] = [];
	for (let at = start; at + BOX_HEADER_BYTES <= end;) {
		let boxBytes = readUnsigned(bytes, at, 4, false);
		if (boxBytes < BOX_HEADER_BYTES || at + boxBytes > end) break;
		found.push({
			type: String.fromCharCode(...bytes.subarray(at + 4, at + BOX_HEADER_BYTES)),
			body: at + BOX_HEADER_BYTES,
			end: at + boxBytes,
		});
		at += boxBytes;
	}
	return found;
}

function avifSize(bytes: Uint8Array): ImageSize | undefined {
	let meta = wholeBoxes(bytes, 0, bytes.length).find(box => box.type === "meta");
	if (!meta) return undefined;
	let metaChildren = wholeBoxes(bytes, meta.body + 4, meta.end);
	let primaryItemBox = metaChildren.find(box => box.type === "pitm");
	let propertiesBox = metaChildren.find(box => box.type === "iprp");
	if (!primaryItemBox || !propertiesBox) return undefined;
	let primaryItem = readUnsigned(
		bytes,
		primaryItemBox.body + 4,
		bytes[primaryItemBox.body] ? 4 : 2,
		false,
	);
	let [propertyContainer, associations] = ["ipco", "ipma"].map(type =>
		wholeBoxes(bytes, propertiesBox.body, propertiesBox.end).find(box => box.type === type)
	);
	if (!propertyContainer || !associations) return undefined;
	let properties = wholeBoxes(bytes, propertyContainer.body, propertyContainer.end);
	let indexBytes = (bytes[associations.body + 3] ?? 0) & 1 ? 2 : 1;
	let itemIdBytes = bytes[associations.body] ? 4 : 2;
	let at = associations.body + 8;
	for (
		let items = readUnsigned(bytes, associations.body + 4, 4, false);
		items-- > 0 && at + itemIdBytes + 1 <= associations.end;
	) {
		let item = readUnsigned(bytes, at, itemIdBytes, false);
		let itemProperties: Box[] = [];
		let propertyCount = bytes[at + itemIdBytes]!;
		at += itemIdBytes + 1;
		for (; propertyCount-- > 0 && at + indexBytes <= associations.end; at += indexBytes) {
			let essentialBitMask = indexBytes === 2 ? 0x7fff : 0x7f;
			let property =
				properties[(readUnsigned(bytes, at, indexBytes, false) & essentialBitMask) - 1];
			if (item === primaryItem && property) itemProperties.push(property);
		}
		if (item !== primaryItem) continue;
		let extent = itemProperties.find(property => property.type === "ispe");
		if (!extent || itemProperties.some(property => property.type === "clap")) return undefined;
		if (extent.end - extent.body < AVIF_EXTENT_BODY_BYTES) return undefined;
		let rotation = itemProperties.find(property => property.type === "irot");
		if (rotation && rotation.end - rotation.body < 1) return undefined;
		return withSidesExchangedWhen(
			sizeWhenPositive(
				readUnsigned(bytes, extent.body + 4, 4, false),
				readUnsigned(bytes, extent.body + 8, 4, false),
			),
			rotation !== undefined && (bytes[rotation.body]! & 1) === 1,
		);
	}
	return undefined;
}

export function rasterSize(bytes: Uint8Array): ImageSize | undefined {
	switch (rasterType(bytes)) {
		case "image/png":
			return pngSize(bytes);
		case "image/jpeg":
			return jpegSize(bytes);
		case "image/gif":
			return gifSize(bytes);
		case "image/bmp":
			return bmpSize(bytes);
		case "image/webp":
			return webpSize(bytes);
		case "image/x-icon":
			return icoSize(bytes);
		case "image/avif":
			return avifSize(bytes);
		default:
			return undefined;
	}
}

export function dataImageSize(src: string): ImageSize | undefined {
	let bytes = dataPayloadStart(src);
	return bytes && rasterSize(bytes);
}
