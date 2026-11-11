import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Transcript } from "./transcript";
import type { ChatDestination } from "../conversation-plan/source";

let destination: ChatDestination = {
	itemId: "thread",
	token: 1,
	source: {
		messageId: "saved",
		author: { kind: "member", handle: "ana" },
		role: "option",
		quote: "A\u{1F9EA} pilot",
		start: 0,
		end: 9,
	},
};

function markup(sourceDestination?: ChatDestination, text = "A\u{1F9EA} pilot") {
	return renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [{ id: "saved", author: { kind: "member", handle: "ana" }, text, ts: 1 }],
		handle: "ana",
		sourceDestination,
	}));
}

test("saved text and its rendered container retain exact UTF-16 source metadata", () => {
	let result = markup();
	expect(result).toContain('data-chat-raw="A\u{1F9EA} pilot"');
	expect(result).toContain("data-chat-message-text");
	expect(result).not.toContain("data-source-exact");
});

test("only the destination message is marked, without a repeated caption", () => {
	let selected = markup(destination);
	expect(selected).toContain("data-chat-source");
	expect(selected).not.toContain("Source:");
	let missing = markup({ ...destination, source: { ...destination.source, messageId: "other" } });
	expect(missing).not.toContain("data-chat-source");
});

test("source metadata preserves current Markdown rendering instead of flattening text", () => {
	let result = markup(destination, "**A\u{1F9EA} pilot**");
	expect(result).toContain('data-chat-raw="**A\u{1F9EA} pilot**"');
	expect(result).toContain(
		'<strong class="aui-md-strong font-semibold">A<span class="chat-emoji">\u{1F9EA}</span> pilot</strong>',
	);
});

function planner(entries: { id: string; text: string; to?: "planner" }[]) {
	return renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: entries.map(entry => ({
			author: { kind: "member" as const, handle: "ana" },
			ts: 1,
			...entry,
		})),
		handle: "ana",
	}));
}

test("a message sent to the Planner starts with an @chopin mention; room messages do not", () => {
	let result = planner([{ id: "m", text: "tighten it", to: "planner" }]);
	expect(result).toContain('<span class="chat-mention">@chopin</span>');
	expect(result).toContain('data-chat-raw="tighten it"');
	expect(result).not.toContain("To Chopin");
	expect(planner([{ id: "m", text: "tighten it" }])).not.toContain("@chopin");
});

test("every message in a run carries the mention, once", () => {
	let entry = (id: string) => ({ id, text: id, to: "planner" as const });
	let result = planner([entry("a"), entry("b"), entry("c")]);
	expect(result.split('chat-mention">@chopin').length - 1).toBe(3);
});

test("a typed leading @chopin is not doubled", () => {
	let result = planner([{ id: "m", text: "@chopin yo", to: "planner" }]);
	expect(result.split("@chopin").length - 1).toBe(2); // mention span + raw attribute
	expect(result).toContain('data-chat-raw="@chopin yo"');
	expect(result).toContain("yo");
});
