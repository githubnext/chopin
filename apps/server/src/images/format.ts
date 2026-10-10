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
