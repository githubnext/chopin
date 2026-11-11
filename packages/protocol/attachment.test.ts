import { describe, expect, it } from "bun:test";

import {
	attachmentName,
	attachmentPath,
	checkAttachment,
	checkAttachmentSize,
	checkMessageAttachments,
	formatBytes,
	refusalText,
	sniffAttachment,
} from "./attachment";
import { INTERNAL } from "./plain-words";

const LIMITS = { maxBytes: 1_048_576, maxCount: 3, maxTotalBytes: 2_097_152 };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10];
const GIF = [...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0];
const WEBP = [
	...new TextEncoder().encode("RIFF"),
	4,
	0,
	0,
	0,
	...new TextEncoder().encode("WEBPVP8 "),
];
const bytes = (value: readonly number[] | string) =>
	typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);

describe("what a file is, from its bytes", () => {
	it("knows each supported raster image by its signature", () => {
		expect(sniffAttachment(bytes(PNG))).toEqual({ kind: "image", mimeType: "image/png" });
		expect(sniffAttachment(bytes(JPEG))).toEqual({ kind: "image", mimeType: "image/jpeg" });
		expect(sniffAttachment(bytes(GIF))).toEqual({ kind: "image", mimeType: "image/gif" });
		expect(sniffAttachment(bytes(WEBP))).toEqual({ kind: "image", mimeType: "image/webp" });
	});

	it("reads UTF-8 as text, with or without a byte order mark and with its own line endings", () => {
		let plain = { kind: "file", mimeType: "text/plain" } as const;
		expect(sniffAttachment(bytes("# Notes\n\nPlan the refund cap.\r\n\ttabbed\f\u001b[0m")))
			.toEqual(plain);
		expect(sniffAttachment(bytes("naïve café 日本語 🎵"))).toEqual(plain);
		expect(sniffAttachment(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes("hello")]))).toEqual(plain);
	});

	it("refuses anything that is neither", () => {
		expect(sniffAttachment(new Uint8Array())).toBeUndefined();
		// A NUL byte, a stray control character, invalid UTF-8, UTF-16 and a zip are not text.
		expect(sniffAttachment(bytes([0x68, 0x69, 0x00]))).toBeUndefined();
		expect(sniffAttachment(bytes([0x68, 0x07, 0x69]))).toBeUndefined();
		expect(sniffAttachment(bytes([0x68, 0xff, 0xfe, 0x69]))).toBeUndefined();
		expect(sniffAttachment(bytes([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBeUndefined();
		expect(sniffAttachment(bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00])))
			.toBeUndefined();
		expect(sniffAttachment(bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]))).toBeUndefined();
	});

	it("does not take a prefix of a signature for the image", () => {
		expect(sniffAttachment(bytes(PNG.slice(0, 7)))).toBeUndefined();
		expect(sniffAttachment(bytes(JPEG.slice(0, 2)))).toBeUndefined();
	});
});

describe("a file checked against its name, its claimed type and the caps", () => {
	it("stores what the bytes say, not what the name says", () => {
		expect(checkAttachment({ name: "notes.txt", type: "text/plain", bytes: bytes("hi") }, LIMITS))
			.toEqual({ ok: true, kind: "file", mimeType: "text/plain" });
		// A JPEG called .png is a JPEG.
		expect(checkAttachment({ name: "shot.png", type: "image/png", bytes: bytes(JPEG) }, LIMITS))
			.toEqual({ ok: true, kind: "image", mimeType: "image/jpeg" });
		// An image called .txt is still an image.
		expect(checkAttachment({ name: "shot.txt", type: "text/plain", bytes: bytes(PNG) }, LIMITS))
			.toEqual({ ok: true, kind: "image", mimeType: "image/png" });
	});

	it("refuses a page or a script that claims to be an image", () => {
		let page = bytes("<!doctype html><script>alert(1)</script>");
		for (let name of ["evil.png", "evil.jpg", "evil.svg"]) {
			expect(checkAttachment({ name, bytes: page }, LIMITS), name).toEqual({
				ok: false,
				reason: "image-type",
			});
		}
		expect(checkAttachment({ name: "x", type: "image/png", bytes: page }, LIMITS)).toEqual({
			ok: false,
			reason: "image-type",
		});
	});

	it("refuses an SVG as an image, as it can carry script", () => {
		let svg = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		expect(checkAttachment({ name: "logo.svg", type: "image/svg+xml", bytes: svg }, LIMITS))
			.toEqual({
				ok: false,
				reason: "image-type",
			});
	});

	it("refuses a binary that is not an image, whatever it is called", () => {
		let zip = bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]);
		expect(checkAttachment({ name: "notes.txt", type: "text/plain", bytes: zip }, LIMITS)).toEqual({
			ok: false,
			reason: "unsupported",
		});
		expect(checkAttachment({ name: "photo.heic", type: "image/heic", bytes: zip }, LIMITS)).toEqual(
			{
				ok: false,
				reason: "image-type",
			},
		);
	});

	it("holds a file to the per-file cap exactly: the cap itself fits, one byte more does not", () => {
		expect(checkAttachmentSize(0, LIMITS)).toBe("empty");
		expect(checkAttachmentSize(1, LIMITS)).toBeUndefined();
		expect(checkAttachmentSize(LIMITS.maxBytes, LIMITS)).toBeUndefined();
		expect(checkAttachmentSize(LIMITS.maxBytes + 1, LIMITS)).toBe("too-large");
		let atCap = new Uint8Array(LIMITS.maxBytes).fill(0x61);
		expect(checkAttachment({ name: "log.txt", bytes: atCap }, LIMITS).ok).toBe(true);
		expect(
			checkAttachment(
				{ name: "log.txt", bytes: new Uint8Array(LIMITS.maxBytes + 1).fill(0x61) },
				LIMITS,
			),
		).toEqual({ ok: false, reason: "too-large" });
		expect(checkAttachment({ name: "log.txt", bytes: new Uint8Array() }, LIMITS)).toEqual({
			ok: false,
			reason: "empty",
		});
	});

	it("holds a message to its count and its total exactly", () => {
		expect(checkMessageAttachments([1, 1, 1], LIMITS)).toBeUndefined();
		expect(checkMessageAttachments([1, 1, 1, 1], LIMITS)).toBe("too-many");
		expect(checkMessageAttachments([1_048_576, 1_048_576], LIMITS)).toBeUndefined();
		expect(checkMessageAttachments([1_048_576, 1_048_576, 1], LIMITS)).toBe("too-much");
		expect(checkMessageAttachments([], LIMITS)).toBeUndefined();
	});
});

describe("names and words", () => {
	it("keeps a name to its file, without folders, controls or marks that reorder a line", () => {
		expect(attachmentName("C:\\Users\\me\\notes.txt", "file")).toBe("notes.txt");
		expect(attachmentName("../../etc/passwd", "file")).toBe("passwd");
		expect(attachmentName("  a\u0000b\u202ec.txt ", "file")).toBe("abc.txt");
		expect(attachmentName("", "image")).toBe("Image");
		expect(attachmentName("///", "file")).toBe("File");
		let long = `${"x".repeat(200)}.log`;
		let kept = attachmentName(long, "file");
		expect([...kept].length).toBe(120);
		expect(kept.endsWith(".log")).toBe(true);
	});

	it("writes a size in words", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(20_480)).toBe("20 KB");
		expect(formatBytes(1_048_576)).toBe("1 MB");
		expect(formatBytes(1_572_864)).toBe("1.5 MB");
	});

	it("says why a file was refused in plain words, naming the file and its limit", () => {
		expect(refusalText("too-large", { name: "log.txt", limits: LIMITS })).toBe(
			"log.txt is over the 1 MB limit for a file.",
		);
		expect(refusalText("image-type", { name: "logo.svg" })).toBe(
			"logo.svg isn't a PNG, JPEG, WebP or GIF image.",
		);
		expect(refusalText("too-many", { limits: LIMITS })).toBe("A message can carry up to 3 files.");
		for (
			let reason of [
				"empty",
				"too-large",
				"unsupported",
				"image-type",
				"too-many",
				"too-much",
				"images-unavailable",
				"upload-failed",
				"not-allowed",
				"gone",
			] as const
		) {
			expect(INTERNAL.test(refusalText(reason, { name: "a.txt", limits: LIMITS })), reason).toBe(
				false,
			);
		}
	});

	it("names where a stored file is read", () => {
		expect(attachmentPath("ch_1", "a/b")).toBe("/api/channels/ch_1/attachments/a%2Fb");
	});
});
