import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Workspace } from "./workspace";

test("the closed Conversation opener has matching top and right clearance", () => {
	let markup = renderToStaticMarkup(
		createElement(Workspace, {
			chat: createElement("div"),
			controls: createElement("div"),
			conversationActivity: { busy: false, unread: 0 },
			decisions: createElement("div"),
			header: createElement("header"),
			mode: "split",
			onConversationOpen: () => {},
			onDesktopConversationOpen: () => {},
			onDestination: () => {},
			plan: createElement("div"),
			state: { conversationOpen: false, desktopConversationOpen: false },
			unanswered: 0,
			view: "plan",
		}),
	);

	expect(markup).toContain("absolute right-5 top-5 z-20");
});
