import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MessageFiles from "./message-files";
import StagedFiles from "./staged-files";

import type { Chat } from "@chopin/protocol";
import type { FileView } from "./files";

const BASE: FileView = {
	id: "a",
	name: "notes.md",
	kind: "file",
	size: 2048,
	sizeLabel: "2 KB",
	state: "done",
	progress: 100,
	retry: false,
};

function staged(files: FileView[]): string {
	return renderToStaticMarkup(createElement(StagedFiles, {
		files,
		source: () => undefined,
		onRemove: () => {},
		onRetry: () => {},
	})).replaceAll("&#x27;", "'");
}

test("a staged file is a chip of assistant-ui's, in a list a screen reader can count", () => {
	let markup = staged([BASE, { ...BASE, id: "b", name: "other.md" }]);
	expect(markup).toMatch(
		/<div[^>]*aria-label="Files to send"[^>]*data-slot="composer-attachments"|<div[^>]*data-slot="composer-attachments"[^>]*aria-label="Files to send"/,
	);
	expect(markup).toContain('role="list"');
	expect(markup.match(/data-slot="composer-attachment"/g)).toHaveLength(2);
	expect(markup.match(/role="listitem"/g)).toHaveLength(2);
	expect(markup).toContain(">notes.md<");
	expect(markup).toContain(">2 KB<");
});

test("a finished upload is removed by the chip's own button, by the file's id, not its name", () => {
	let markup = staged([BASE]);
	expect(markup).toContain('aria-label="Remove notes.md"');
	// Chopin draws no second remove button beside the chip's own.
	expect(markup.match(/Remove notes\.md/g)).toHaveLength(1);
	expect(markup).not.toContain("btn-icon-xs");
});

test("an upload in progress shows its percent and can be taken back", () => {
	let markup = staged([{ ...BASE, state: "uploading", sizeLabel: "40%", progress: 40 }]);
	expect(markup).toContain(">40%<");
	expect(markup).toContain('data-state="uploading"');
	expect(markup).toContain("width:40%");
	expect(markup).toMatch(/<button[^>]*aria-label="Remove notes.md"[^>]*data-chopin-control=""/);
});

test("a file that did not go says why on its chip and is announced once, with a way to try again or to remove it", () => {
	let markup = staged([{
		...BASE,
		state: "error",
		sizeLabel: "2 KB",
		error: "notes.md didn't upload.",
		retry: true,
	}]);
	expect(markup).toContain('data-state="error"');
	expect(markup).toContain(">notes.md didn't upload.<");
	expect(markup).toMatch(/<p class="sr-only" role="alert">notes.md. notes.md didn't upload.<\/p>/);
	expect(markup).toContain('aria-label="Try notes.md again"');
	expect(markup).toContain('aria-label="Remove notes.md"');
});

test("a refusal that trying again cannot cure offers only removal", () => {
	let markup = staged([{
		...BASE,
		state: "error",
		error: "That file is too large.",
		retry: false,
	}]);
	expect(markup).not.toContain("again");
	expect(markup).toContain('aria-label="Remove notes.md"');
});

test("nothing is announced while every file is fine", () => {
	expect(staged([BASE])).toMatch(/<p class="sr-only" role="alert"><\/p>/);
});

const SENT: Chat.Attachment[] = [
	{ id: "img", name: "shot.png", kind: "image", mimeType: "image/png", size: 1234 },
	{ id: "txt", name: "notes.md", kind: "file", mimeType: "text/plain", size: 2048 },
];

test("a sent message draws its images through Chat's image elements and keeps non-image files on MessageAttachments", () => {
	let markup = renderToStaticMarkup(
		createElement(MessageFiles, { channelId: "room", files: SENT }),
	);
	expect(markup).toContain('data-chat-image="single"');
	expect(markup).toContain('data-slot="image-root"');
	expect(markup).toContain('src="/api/channels/room/attachments/img"');
	expect(markup).toContain('alt="shot.png"');
	expect(markup).toContain('data-slot="message-attachments"');
	expect(markup).toContain('aria-label="Files sent with this message"');
	expect(markup).toContain(">notes.md<");
	expect(markup).not.toContain("background-image:");
});

test("several sent images form an ImageGallery, and an oversized image attachment shows the 10 MB placeholder", () => {
	let gallery = renderToStaticMarkup(
		createElement(MessageFiles, {
			channelId: "room",
			files: [
				SENT[0]!,
				{ id: "img2", name: "second.webp", kind: "image", mimeType: "image/webp", size: 900 },
			],
		}),
	);
	expect(gallery).toContain('data-slot="image-gallery"');
	expect(gallery.match(/data-chat-image="tile"/g)).toHaveLength(2);
	expect(gallery).not.toContain('data-slot="message-attachments"');

	let oversized = renderToStaticMarkup(
		createElement(MessageFiles, {
			channelId: "room",
			files: [
				{
					id: "huge",
					name: "huge.png",
					kind: "image",
					mimeType: "image/png",
					size: 12 * 1_048_576,
				},
			],
		}),
	);
	expect(oversized).toContain("Image too large to show (12 MB, limit 10 MB)");
	expect(oversized).not.toContain("<img");
});
