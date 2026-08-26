import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationToggle, WorkspaceFeedbackCount } from "./workspace";

test("conversation state swaps use purposeful icon feedback", () => {
	let markup = renderToStaticMarkup(
		createElement(ConversationToggle, {
			activity: { busy: false, unread: 0 },
			controls: "conversation",
			onToggle: () => {},
			open: false,
		}),
	);

	expect(markup).toContain('data-motion-feedback="icon"');
	expect(markup).toContain("motion-feedback");
});

test("the open conversation hover swap crossfades without display changes", () => {
	let markup = renderToStaticMarkup(
		createElement(ConversationToggle, {
			activity: { busy: false, unread: 0 },
			controls: "conversation",
			onToggle: () => {},
			open: true,
			swapOnHover: true,
		}),
	);

	expect(markup.match(/class="conversation-toggle-icon/g)).toHaveLength(2);
	expect(markup).not.toContain("group-hover:hidden");
	expect(markup).not.toContain("group-hover:block");
});

test("unread counts enter while live busy feedback stays immediate", () => {
	let unread = renderToStaticMarkup(
		createElement(WorkspaceFeedbackCount, null, 2),
	);
	let busy = renderToStaticMarkup(
		createElement(ConversationToggle, {
			activity: { busy: true, unread: 0 },
			controls: "conversation",
			onToggle: () => {},
			open: false,
		}),
	);

	expect(unread).toContain('data-motion-feedback="count"');
	expect(busy).not.toContain('data-motion-feedback="count"');
});
