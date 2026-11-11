import { expect, test } from "bun:test";

import { promptWithAttachments } from "./attachment-prompt";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const NOTES = new TextEncoder().encode("# Notes\n");
const sent = [
	{ name: "shot.png", kind: "image" as const, mimeType: "image/png", bytes: PNG },
	{ name: "notes.md", kind: "file" as const, mimeType: "text/plain", bytes: NOTES },
];

test("a model that reads images is given the image as an image part and the text file as a file part", () => {
	let message = promptWithAttachments("@ana: What is this?", sent, true);
	expect(message).toEqual({
		role: "user",
		content: [
			{ type: "text", text: "@ana: What is this?" },
			{
				type: "image",
				image: PNG,
				mediaType: "image/png",
				providerOptions: { chopin: { name: "shot.png" } },
			},
			{ type: "file", data: NOTES, mediaType: "text/plain", filename: "notes.md" },
		],
	});
});

test("a model that cannot read images is told in words which images were sent, and gets the text file", () => {
	let message = promptWithAttachments("@ana: What is this?", sent, false);
	expect(message.content).toEqual([
		{
			type: "text",
			text:
				"@ana: What is this?\n\n(Sent with this message but not shown, because this model can't read images: shot.png.)",
		},
		{ type: "file", data: NOTES, mediaType: "text/plain", filename: "notes.md" },
	]);
});

test("a message with only text files says nothing of images", () => {
	let message = promptWithAttachments("@ana: Read", [sent[1]!], false);
	expect(message.content).toEqual([
		{ type: "text", text: "@ana: Read" },
		{ type: "file", data: NOTES, mediaType: "text/plain", filename: "notes.md" },
	]);
});
