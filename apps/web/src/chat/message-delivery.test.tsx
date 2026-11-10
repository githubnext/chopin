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
		onWithdraw: () => {},
		queued: [],
		quietFailures,
	}));
}

function mark(markup: string): string | undefined {
	return /data-chat-delivery="(\w+)"/.exec(markup)?.[1];
}

test("a message only this browser has waits to send, with a clock a screen reader reads, and can be taken back", () => {
	let [echo] = echoes([{
		payload: { requestId: crypto.randomUUID(), text: "@chopin outline it", to: "planner" },
		handle: "ana",
		ts: 1_700_000_000,
	}]) as LocalEntry[];
	let markup = render([echo!]);
	expect(mark(markup)).toBe("waiting");
	expect(markup).toContain('aria-label="Waiting to send"');
	expect(markup).toContain("<circle");
	expect(markup).toContain('aria-label="Message actions"');
	expect(markup).toContain("outline it");
});

test("a message the server has but the machine has not taken is Sent, with one tick, and can be taken back", () => {
	let markup = render([mine("a", "@chopin outline it", { deliveryState: "sent" })]);
	expect(mark(markup)).toBe("sent");
	expect(markup).toContain('aria-label="Sent"');
	expect(markup.match(/<path d="M2\.75,9/g)).toHaveLength(1);
	expect(markup).toContain('aria-label="Message actions"');
});

test("a delivered message has two ticks and no menu, and one from before the marks existed has neither", () => {
	let delivered = render([mine("a", "@chopin outline it", { deliveryState: "delivered" })]);
	expect(mark(delivered)).toBe("delivered");
	expect(delivered).toContain('aria-label="Delivered"');
	expect(delivered.match(/<path d="M2\.75,9/g)).toHaveLength(2);
	expect(delivered).not.toContain("Message actions");
	let older = render([mine("a", "@chopin outline it")]);
	expect(mark(older)).toBeUndefined();
	expect(older).not.toContain("Message actions");
});

test("only the sender sees the mark and the menu; a teammate's message shows neither", () => {
	let markup = render([{
		...mine("a", "@chopin outline it", { deliveryState: "sent" }),
		author: { kind: "member", handle: "bo" },
	}]);
	expect(mark(markup)).toBeUndefined();
	expect(markup).not.toContain("Message actions");
});

test("a message that can never be delivered says Couldn't send on itself, why, and offers Try again and Delete, never a strip", () => {
	let markup = render([
		mine("a", "@chopin outline it", {
			deliveryState: "failed",
			deliveryFailure: "machine-removed",
		}),
	]);
	expect(markup).toContain("data-chat-failed");
	expect(markup).toContain("Couldn&#x27;t send.");
	expect(markup).toContain("The machine it was for was removed from this document.");
	expect(markup).toMatch(/>Try again<\/button>/);
	expect(markup).toMatch(/>Delete<\/button>/);
	expect(mark(markup)).toBeUndefined();
	expect(markup).not.toContain('role="alert"');
});

test("while the page's connection banner shows, a message's Couldn't send gives way to it and comes back with the connection", () => {
	let failed = mine("a", "@chopin outline it", {
		deliveryState: "failed",
		deliveryFailure: "machine-removed",
	});
	let offline = render([failed], true);
	expect(offline).not.toContain("data-chat-failed");
	expect(offline).not.toContain("Couldn&#x27;t send.");
	expect(offline).not.toContain("The machine it was for was removed from this document.");
	expect(offline).toContain("outline it");
	let online = render([failed]);
	expect(online).toContain("data-chat-failed");
	expect(online).toContain("Couldn&#x27;t send.");
});
