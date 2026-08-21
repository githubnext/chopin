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
