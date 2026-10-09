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
});

test("the open chat header swaps its glyph without display changes", () => {
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
	expect(markup).toContain('aria-label="Hide chat"');
	expect(markup).toContain("chat-toggle-icon-sidebar");
	expect(markup).toContain("rotate-180");
	expect(markup).not.toContain("group-hover:hidden");
	expect(markup).not.toContain("group-hover:block");
});

test("the open chat control has a distinct close action", () => {
	let markup = renderToStaticMarkup(
		createElement(ChatToggle, {
			activity: { busy: false, unread: 0 },
			controls: "chat",
			onToggle: () => {},
			open: true,
		}),
	);

	expect(markup).toContain('aria-label="Hide chat"');
	expect(markup).toContain('data-tooltip="Hide chat"');
	expect(markup).toContain('data-tooltip-verbatim=""');
	expect(markup).toContain("panel-close.svg");
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

	expect(markup).toContain('aria-label="Show chat, Planner working"');
	expect(markup).not.toContain('data-motion-feedback="count"');
});
