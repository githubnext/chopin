import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Transcript } from "./transcript";

import type { Chat } from "@chopin/protocol";

function entry(): Chat.Entry {
	return {
		id: "message-1",
		author: { kind: "member", handle: "maggie" },
		text: "hello",
		ts: 1_700_000_000,
	};
}

test("keeps a short transcript against the composer with compact message metadata", () => {
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: false,
		arrived: new Set<string>(),
		entries: [entry()],
		handle: "maggie",
		onWithdraw: () => {},
		queued: [],
	}));

	expect(markup).toContain('data-chat-stack="true"');
	expect(markup).toContain("min-h-full flex-col justify-end gap-6");
	expect(markup).toContain("-mt-0.5 flex min-w-0 flex-1 flex-col gap-1");
});
