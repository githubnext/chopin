import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SurfaceToggle } from "./workspace";

let render = (expanded: boolean, activity = { busy: false, unread: 0 }) =>
	renderToStaticMarkup(createElement(SurfaceToggle, {
		activity,
		controls: "chat",
		expanded,
		onToggle: () => {},
	}));

test("the expand control is an icon button that names the document", () => {
	let markup = render(false);

	expect(markup).toContain('aria-label="Expand document"');
	expect(markup).toContain('data-tooltip="Expand document"');
	expect(markup).toContain('aria-controls="chat"');
	expect(markup).not.toContain("aria-expanded");
	expect(markup).toContain("btn-icon");
	expect(markup).toContain('data-motion-feedback="icon"');
	expect(markup).not.toContain("panel-close.svg");
	expect(markup).not.toContain(">Chat<");
});

test("the restore control shows a Chat label and reports Planner activity", () => {
	let busy = render(true, { busy: true, unread: 0 });
	let unread = render(true, { busy: false, unread: 2 });

	expect(busy).toContain('aria-label="Show chat, Planner working"');
	expect(busy).toContain('aria-expanded="false"');
	expect(busy).toContain(">Chat</span>");
	expect(busy).not.toContain('data-motion-feedback="count"');
	expect(unread).toContain('aria-label="Show chat, 2 unread"');
	expect(unread).toContain('data-motion-feedback="count"');
	expect(unread.match(/<span aria-hidden="true"/g)).toHaveLength(1);
});
