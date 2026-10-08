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
	expect(result).toContain("<strong>A\u{1F9EA} pilot</strong>");
});

test("a message sent to the Planner is labelled; room messages are not", () => {
	let render = (to?: "planner") =>
		renderToStaticMarkup(createElement(Transcript, {
			active: true,
			entries: [{
				id: "m",
				author: { kind: "member", handle: "ana" },
				text: "tighten it",
				ts: 1,
				...(to ? { to } : {}),
			}],
			handle: "ana",
			onWithdraw: () => {},
			queued: [],
		}));
	expect(render("planner")).toContain("To Chopin");
	expect(render()).not.toContain("To Chopin");
});

test("To Chopin appears once per run and never in persistent Chopin mode", () => {
	let entry = (id: string) => ({
		id,
		author: { kind: "member" as const, handle: "ana" },
		text: id,
		ts: 1,
		to: "planner" as const,
	});
	let render = (talkingToChopin?: boolean) =>
		renderToStaticMarkup(createElement(Transcript, {
			active: true,
			entries: [entry("a"), entry("b")],
			handle: "ana",
			onWithdraw: () => {},
			queued: [{ id: "q", handle: "ana", text: "queued" }],
			talkingToChopin,
		})).split("To Chopin").length - 1;
	expect(render()).toBe(2); // the sent run, then the queued message
	expect(render(true)).toBe(0);
});
