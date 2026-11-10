import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageQueue } from "./message-queue";

import type { QueueRow } from "./queue-model";

const row = (id: string, text: string, extra: Partial<QueueRow> = {}): QueueRow => ({
	id,
	name: "Ana",
	handle: "ana",
	text,
	message: true,
	mine: false,
	...extra,
});

const settle = async () => undefined;

function render(queued: QueueRow[], controls = true) {
	return renderToStaticMarkup(
		createElement(MessageQueue, {
			queued,
			...(controls ? { onCancel: settle, onEdit: settle } : {}),
		}),
	);
}

test("draws nothing when nothing waits", () => {
	expect(render([])).toBe("");
});

test("the default state: a count, then each waiting message in order, with who asked and a preview", () => {
	let markup = render([
		row("a", "Compare the options.", { mine: true }),
		row("b", "Tighten the intro.", { name: "Felix", handle: "felix" }),
	]);
	expect(markup).toContain('data-slot="message-queue"');
	expect(markup).toContain('aria-label="Waiting for Chopin"');
	expect(markup).toContain("2 waiting for Chopin");
	expect(markup.indexOf("Compare the options.")).toBeLessThan(markup.indexOf("Tighten the intro."));
	expect(markup).toContain(">Felix<");
	expect(markup).toMatch(/<ol[^>]*>.*<li[^>]*data-queue-id="a".*<li[^>]*data-queue-id="b"/s);
	// The place in the queue is drawn for the eye and read from the list's own order.
	expect(markup).toMatch(/aria-hidden="true" class="chat-queue-place">1</);
	expect(markup).toMatch(/aria-hidden="true" class="chat-queue-place">2</);
	// A polite region, empty until a change is made.
	expect(markup).toMatch(/aria-live="polite"[^>]*role="status"[^>]*><\/span>/);
});

test("the author alone is offered Edit and Cancel, each named for the message it changes", () => {
	let markup = render([
		row("a", "Compare the options.", { mine: true }),
		row("b", "Tighten the intro.", { name: "Felix", handle: "felix" }),
	]);
	expect(markup).toContain('aria-label="Edit message from Ana"');
	expect(markup).toContain('aria-label="Cancel message from Ana"');
	expect(markup).not.toContain("from Felix");
	expect(markup.match(/class="btn btn-xs btn-ghost"/g)).toHaveLength(2);
});

test("a saved waiting message keeps its sender's Sent mark and Delete menu in the queue", () => {
	let markup = renderToStaticMarkup(createElement(MessageQueue, {
		queued: [
			row("a", "My message", { mine: true, sent: true }),
			row("b", "Someone else's message", { name: "Felix", handle: "felix", sent: true }),
		],
		onDelete: () => {},
	}));
	expect(markup).toContain('data-chat-message-id="a"');
	expect(markup).toContain('data-chat-message-id="b"');
	expect(markup.match(/aria-label="Sent"/g)).toHaveLength(1);
	expect(markup.match(/aria-label="Message actions"/g)).toHaveLength(1);
});

test("beside Cancel the Delete menu is kept but quiet, and it is the only way to take back a message when Cancel is not offered", () => {
	let sent = [row("a", "My message", { mine: true, sent: true })];
	let withCancel = renderToStaticMarkup(createElement(MessageQueue, {
		queued: sent,
		onCancel: settle,
		onEdit: settle,
		onDelete: () => {},
	}));
	expect(withCancel).toContain('aria-label="Cancel message from Ana"');
	expect(withCancel).toContain('aria-label="Message actions"');
	expect(withCancel).toMatch(/class="chat-message-menu-anchor"[^>]*data-quiet="true"/);
	// Offline there is no Cancel, so the menu is the way, and is drawn as it always is.
	let offline = renderToStaticMarkup(createElement(MessageQueue, {
		queued: sent,
		onDelete: () => {},
	}));
	expect(offline).not.toContain("Cancel message");
	expect(offline).toContain('aria-label="Message actions"');
	expect(offline).not.toContain("data-quiet");
});

test("the list says nothing about rows beyond its edges until it has been measured in a browser", () => {
	let markup = render(
		Array.from({ length: 6 }, (_, index) => row(`m${index}`, `Message ${index}`)),
	);
	expect(markup).toContain('class="chat-queue-list"');
	expect(markup).not.toContain("data-beyond");
});

test("the no-cancel state: a queue nobody may change has no controls, whoever wrote what", () => {
	let markup = render([row("a", "Compare the options.", { mine: true })], false);
	expect(markup).toContain("Compare the options.");
	expect(markup).not.toContain("<button");
	expect(markup).not.toContain("Edit message");
	// Only a person's own message is changed, whatever the caller allows.
	expect(render([row("b", "Theirs")])).not.toContain("<button");
});

test("the long-content state: a long message is kept to one line, whole in its title", () => {
	let long =
		"When the sidebar is narrow, can the state labels fold into glyphs before the title truncates? "
			.repeat(4);
	let markup = render([row("a", long, { mine: true })]);
	expect(markup).toContain("data-chat-queue-text");
	expect(markup).toContain(`title="${long}"`);
});

test("work nobody typed is told in plain words, in Chopin's name, and cannot be changed", () => {
	let markup = render([
		row("c", "Reply to a comment", { message: false, mine: false }),
		row("j", "Re-checking decisions against the document", {
			name: "Chopin",
			handle: undefined,
			message: false,
		}),
	]);
	expect(markup).toContain('data-queue-kind="work"');
	expect(markup).toContain("Reply to a comment");
	expect(markup).toContain(">Chopin<");
	expect(markup).toContain('aria-label="Chopin"');
	expect(markup).not.toContain("<button");
});

test("keeps every waiting row in order in the queue", () => {
	let rows = Array.from({ length: 5 }, (_, index) => row(`m${index}`, `Message ${index}`));
	let markup = render(rows);
	expect(markup).toContain("5 waiting for Chopin");
	expect([...markup.matchAll(/data-queue-id="(m\d)"/g)].map(match => match[1])).toEqual([
		"m0",
		"m1",
		"m2",
		"m3",
		"m4",
	]);
});

test("is an ordinary collapsing region, open from its first frame", () => {
	let markup = render([row("a", "x")]);
	expect(markup).toContain('class="chat-queue-motion motion-collapse is-open"');
	expect(markup).toContain('class="motion-collapse-content"');
	expect(markup).not.toContain("is-closing");
	expect(markup).not.toContain("inert");
});
