import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { echoes } from "./delivery";
import { Transcript } from "./transcript";

import type { Chat } from "@chopin/protocol";
import type { LocalEntry } from "./delivery";

function mine(
	id: string,
	text: string,
	extra: Partial<Chat.Entry> = {},
): Chat.Entry {
	return {
		id,
		author: { kind: "member", handle: "ana" },
		text,
		ts: 1_700_000_000,
		to: "planner",
		...extra,
	};
}

function render(entries: Chat.Entry[], quietFailures = false): string {
	return renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries,
		handle: "ana",
		quietFailures,
	}));
}

function mark(markup: string): string | undefined {
	return /data-chat-delivery="(\w+)"/.exec(markup)?.[1];
}

test("a message only this browser has says Sending, in words and with no clock, and a message the server has says nothing", () => {
	let [echo] = echoes([{
		payload: { requestId: crypto.randomUUID(), text: "@chopin outline it", to: "planner" },
		handle: "ana",
		ts: 1_700_000_000,
	}]) as LocalEntry[];
	let markup = render([echo!]);
	expect(mark(markup)).toBe("sending");
	expect(markup).toContain(">Sending</span>");
	expect(markup).not.toContain("<circle");
	expect(markup).not.toContain("Message actions");
	expect(markup).toContain("outline it");
	let sent = render([mine("a", "@chopin outline it")]);
	expect(mark(sent)).toBeUndefined();
	expect(sent).not.toContain("Sending");
});

test("only the sender sees the mark; a teammate's message shows none", () => {
	let [echo] = echoes([{
		payload: { requestId: crypto.randomUUID(), text: "@chopin outline it", to: "planner" },
		handle: "bo",
		ts: 1_700_000_000,
	}]) as LocalEntry[];
	let markup = render([echo!]);
	expect(mark(markup)).toBeUndefined();
	expect(markup).not.toContain("Sending");
});

test("a message the server refused says Couldn't send on itself, why, and offers Try again and Delete, never a strip", () => {
	let [echo] = echoes([{
		payload: { requestId: crypto.randomUUID(), text: "@chopin outline it", to: "planner" },
		handle: "ana",
		ts: 1_700_000_000,
		failure: "Chopin can't take messages while it works on this machine. Stop it to ask now.",
	}]) as LocalEntry[];
	let markup = render([echo!]);
	expect(markup).toContain("data-chat-failed");
	expect(markup).toContain("Couldn&#x27;t send.");
	expect(markup).toContain(
		"Chopin can&#x27;t take messages while it works on this machine. Stop it to ask now.",
	);
	expect(markup).toMatch(/>Try again<\/button>/);
	expect(markup).toMatch(/>Delete<\/button>/);
	expect(mark(markup)).toBeUndefined();
	expect(markup).not.toContain('role="alert"');
});

test("while the page's connection banner shows, a message's Couldn't send gives way to it and comes back with the connection", () => {
	let [failed] = echoes([{
		payload: { requestId: crypto.randomUUID(), text: "@chopin outline it", to: "planner" },
		handle: "ana",
		ts: 1_700_000_000,
		failure: "No machine is connected to reply.",
	}]) as LocalEntry[];
	let offline = render([failed!], true);
	expect(offline).not.toContain("data-chat-failed");
	expect(offline).not.toContain("Couldn&#x27;t send.");
	expect(offline).not.toContain("No machine is connected to reply.");
	expect(offline).toContain("outline it");
	let online = render([failed!]);
	expect(online).toContain("data-chat-failed");
	expect(online).toContain("Couldn&#x27;t send.");
});
