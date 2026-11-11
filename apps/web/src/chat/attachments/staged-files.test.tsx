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

test("a sent message's files are assistant-ui's received files, each a button that can be opened", () => {
	let markup = renderToStaticMarkup(
		createElement(MessageFiles, { channelId: "room", files: SENT }),
	);
	expect(markup).toContain('data-slot="message-attachments"');
	expect(markup).toContain('aria-label="Files sent with this message"');
	expect(markup.match(/<button/g)).toHaveLength(2);
	expect(markup).toContain(">shot.png<");
	expect(markup).toContain(">notes.md<");
	// The picture is the stored file, which the server serves to those who can read the document.
	expect(markup).toMatch(/background-image:url\(&quot;\/[^"]*\/room\/[^"]*img/);
	expect(markup).not.toMatch(/background-image:[^"]*txt/);
});
