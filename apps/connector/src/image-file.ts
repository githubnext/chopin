import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Chopin hosts images of at most 1 MiB. */
export const MAX_IMAGE_FILE_BYTES = 1024 * 1024;

const TOO_LARGE =
	"Take a smaller screenshot (a 1280x800 viewport PNG of the running prototype) and upload that.";

function mimeType(bytes: Uint8Array): string | undefined {
	let ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
	if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
}

/**
 * Read a PNG, JPEG or WebP inside the run's worktree as upload_investigation_image arguments, so
 * the agent passes a path instead of emitting the image's base64 as tokens.
 */
export async function imageFileArguments(
	root: string,
	path: string,
): Promise<{ data: string; mimeType: string }> {
	let base = await realpath(root);
	let target: string;
	try {
		target = await realpath(resolve(base, path));
	} catch {
		throw new Error(`No file at ${path} in this worktree.`);
	}
	let inside = relative(base, target);
	if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
		throw new Error("Upload only image files inside this run's worktree.");
	}
	let bytes = new Uint8Array(await readFile(target));
	let type = mimeType(bytes);
	if (!type) throw new Error("Upload a PNG, JPEG or WebP image.");
	if (bytes.byteLength > MAX_IMAGE_FILE_BYTES) {
		let size = Math.ceil(bytes.byteLength / 1024);
		throw new Error(`${path} is ${size} KiB; images are limited to 1 MiB. ${TOO_LARGE}`);
	}
	return { data: Buffer.from(bytes).toString("base64"), mimeType: type };
}
