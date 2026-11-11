import { describe, expect, it } from "bun:test";

import { promptParts as atomic } from "./atomic/adapter";
import { promptParts as copilot } from "./copilot-sdk/adapter";

import type { UserModelMessage } from "ai";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const NOTES = new TextEncoder().encode("# Notes\n");
const message: UserModelMessage = {
	role: "user",
	content: [
		{ type: "text", text: "@ana: Look" },
		{ type: "image", image: PNG, mediaType: "image/png" },
		{ type: "file", data: NOTES, mediaType: "text/plain", filename: 'no"tes.md' },
	],
};
const FILE = '<file name="no\\"tes.md">\n# Notes\n\n</file>';

describe("what a turn's prompt comes to for each harness that runs on this server", () => {
	it("keeps a plain prompt exactly as it is", () => {
		expect(atomic("hello")).toEqual({ text: "hello", images: [] });
		expect(copilot("hello")).toEqual({ prompt: "hello", attachments: [] });
		let text: UserModelMessage = { role: "user", content: "hi" };
		expect(atomic(text)).toEqual({ text: "hi", images: [] });
		expect(copilot(text)).toEqual({ prompt: "hi", attachments: [] });
	});

	it("gives Atomic the image as its own image and writes the text file into the prompt under its name", () => {
		expect(atomic(message)).toEqual({
			text: `@ana: Look\n\n${FILE}`,
			images: [{ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" }],
		});
	});

	it("gives the Copilot SDK the image as a blob attachment and the text file in the prompt", () => {
		expect(copilot(message)).toEqual({
			prompt: `@ana: Look\n\n${FILE}`,
			attachments: [{
				type: "blob",
				data: Buffer.from(PNG).toString("base64"),
				mimeType: "image/png",
			}],
		});
	});

	it("refuses to run a prompt part it cannot give the model, rather than dropping it", () => {
		let url: UserModelMessage = {
			role: "user",
			content: [{
				type: "file",
				data: new URL("https://example.test/a.pdf"),
				mediaType: "application/pdf",
			}],
		};
		expect(() => atomic(url)).toThrow("does not support");
	});
});
