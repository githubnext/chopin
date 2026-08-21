import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Chat } from "./chat";

test("the composer keeps equal clearance from the Conversation pane edges", () => {
	let markup = renderToStaticMarkup(
		createElement(Chat, { connected: false, handle: "maggie", wire: undefined }),
	);

	expect(markup).toContain("conversation-composer shrink-0 px-2.5 pb-2.5");
});

test("the composer sends with a white arrow inside a petrol circle", () => {
	let markup = renderToStaticMarkup(
		createElement(Chat, { connected: false, handle: "maggie", wire: undefined }),
	);

	expect(markup).toContain("conversation-send-button btn btn-icon btn-primary rounded-full");
	expect(markup).toContain("conversation-send-icon size-[14px]");
	expect(markup).toContain("send-arrow-up.svg");
});

test("the send action keeps an eight pixel inset from the composer edges", () => {
	let markup = renderToStaticMarkup(
		createElement(Chat, { connected: false, handle: "maggie", wire: undefined }),
	);

	expect(markup).toContain("flex items-center justify-end gap-1 px-2 pb-2");
});
