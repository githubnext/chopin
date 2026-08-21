import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Workspace } from "./workspace";

test("the closed Conversation opener matches the tab bar inset", () => {
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

	expect(markup).toContain("absolute right-2.5 top-2.5 z-20");
	expect(markup.match(/size-\[14px\]/g)).toHaveLength(3);
});

test("split pane bodies continue the workspace frame's inset edge", () => {
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
			state: { conversationOpen: false, desktopConversationOpen: true },
			unanswered: 0,
			view: "plan",
		}),
	);

	expect(markup).toContain("bg-conversation-pane hairline-l hairline-r hairline-b");
	expect(markup).toContain("order-1 relative min-w-0 w-full flex-1 hairline-l hairline-b");
});

test("Conversation header icons use the compact 14px measure", () => {
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
			state: { conversationOpen: false, desktopConversationOpen: true },
			unanswered: 0,
			view: "plan",
		}),
	);

	expect(markup.match(/size-\[14px\]/g)).toHaveLength(2);
});
