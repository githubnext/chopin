import { isImageType, matchesSignature, MAX_IMAGE_BYTES } from "../images/format";
import { shrinkToFit } from "../images/resize";

import type { ImageType } from "../images/format";

export type UploadImageInput = { id: string; mimeType: ImageType; bytes: Uint8Array };

export type UploadImageRefusal = "too-large" | "unsupported-type" | "signature-mismatch";

const MAX_DOCUMENT_LOCATOR_LENGTH = 2_048;
// One pass with no backtracking: a group repeated over megabytes of data runs out of the engine's
// budget and fails a valid image.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The largest image the upload tools take. A document stores an image of at most
 * `MAX_IMAGE_BYTES`, so a larger one is stored as a smaller copy of itself, never refused.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 16 * 1_048_576;
/** Base64 characters of the largest accepted image. */
export const MAX_IMAGE_DATA_LENGTH = Math.ceil(MAX_IMAGE_UPLOAD_BYTES / 3) * 4;
/** Admits the largest accepted image's base64 plus its JSON-RPC envelope and locator. */
export const MAX_IMAGE_REQUEST_BYTES = MAX_IMAGE_DATA_LENGTH + 64 * 1024;

/**
 * Validate `upload_image` arguments. Undefined means malformed arguments; a
 * refusal names a well-formed image Chopin will not host. An image over the stored size is
 * made smaller (`too-large` is only an image over `MAX_IMAGE_UPLOAD_BYTES`, or one that does not
 * decode to make a smaller copy of).
 */
export async function prepareImage(
	value: Record<string, unknown>,
): Promise<{ input: UploadImageInput } | { refusal: UploadImageRefusal } | undefined> {
	let expected = ["id", "data", "mimeType"];
	if (
		Object.keys(value).length !== expected.length
		|| expected.some(key => !Object.hasOwn(value, key))
		|| typeof value.id !== "string"
		|| Array.from(value.id).length > MAX_DOCUMENT_LOCATOR_LENGTH
		|| !value.id.trim()
		|| typeof value.data !== "string"
		|| typeof value.mimeType !== "string"
	) return undefined;
	if (!isImageType(value.mimeType)) return { refusal: "unsupported-type" };
	let data = value.data;
	if (data.length > MAX_IMAGE_DATA_LENGTH) return { refusal: "too-large" };
	if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
	let bytes = new Uint8Array(Buffer.from(data, "base64"));
	if (bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) return { refusal: "too-large" };
	if (!matchesSignature(value.mimeType, bytes)) return { refusal: "signature-mismatch" };
	if (bytes.byteLength <= MAX_IMAGE_BYTES) {
		return { input: { id: value.id, mimeType: value.mimeType, bytes } };
	}
	let fitted = await shrinkToFit(bytes, value.mimeType, MAX_IMAGE_BYTES);
	if (!fitted) return { refusal: "too-large" };
	return { input: { id: value.id, mimeType: fitted.mimeType, bytes: fitted.bytes } };
}
