import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatToggle } from "./workspace";

test("chat state swaps use purposeful icon feedback", () => {
	let markup = renderToStaticMarkup(
		createElement(ChatToggle, {
			activity: { busy: false, unread: 0 },
			controls: "chat",
			onToggle: () => {},
			open: false,
		}),
	);

	expect(markup).toContain('data-motion-feedback="icon"');
	expect(markup).toContain("motion-feedback");
	expect(markup).toContain("size-[14px]");
});

test("the open chat hover swap crossfades without display changes", () => {
	let markup = renderToStaticMarkup(
		createElement(ChatToggle, {
			activity: { busy: false, unread: 0 },
			controls: "chat",
			onToggle: () => {},
			open: true,
			swapOnHover: true,
		}),
	);

	expect(markup.match(/class="chat-toggle-icon/g)).toHaveLength(2);
	expect(markup.match(/size-\[14px\]/g)).toHaveLength(3);
	expect(markup).not.toContain("group-hover:hidden");
	expect(markup).not.toContain("group-hover:block");
});

test("live busy feedback stays immediate", () => {
	let markup = renderToStaticMarkup(
		createElement(ChatToggle, {
			activity: { busy: true, unread: 0 },
			controls: "chat",
			onToggle: () => {},
			open: false,
		}),
	);

	expect(markup).toContain('aria-label="Show chat pane, Planner working"');
	expect(markup).not.toContain('data-motion-feedback="count"');
});
