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
		onWithdraw: () => {},
		queued: [],
		sourceDestination,
	}));
}

test("saved text and its rendered container retain exact UTF-16 source metadata", () => {
	let result = markup();
	expect(result).toContain('data-chat-raw="A\u{1F9EA} pilot"');
	expect(result).toContain("data-chat-message-text");
	expect(result).not.toContain("data-source-preview");
	expect(result).not.toContain("data-source-exact");
});

test("only the destination message gets its exact source preview and target class", () => {
	let selected = markup(destination);
	expect(selected).toContain("rounded-md bg-inset px-1");
	expect(selected).toContain("data-source-preview");
	expect(selected).toContain("Source: “A\u{1F9EA} pilot”");
	let missing = markup({ ...destination, source: { ...destination.source, messageId: "other" } });
	expect(missing).not.toContain("data-source-preview");
	expect(missing).not.toContain("rounded-md bg-inset px-1");
});

test("source metadata preserves current Markdown rendering instead of flattening text", () => {
	let result = markup(destination, "**A\u{1F9EA} pilot**");
	expect(result).toContain('data-chat-raw="**A\u{1F9EA} pilot**"');
	expect(result).toContain("<strong>A\u{1F9EA} pilot</strong>");
});
