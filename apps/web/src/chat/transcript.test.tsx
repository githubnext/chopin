import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Transcript } from "./transcript";

test("system presence entries stay immediate when they arrive", () => {
	let markup = renderToStaticMarkup(
		createElement(Transcript, {
			active: true,
			entries: [{
				author: { kind: "system" },
				id: "joined",
				text: "@sam joined",
				ts: 1_700_000_000,
			}],
			handle: "ana",
			onWithdraw: () => {},
			queued: [],
		}),
	);

	expect(markup).toContain("Sam joined");
	expect(markup).not.toContain("data-motion-feedback");
});

test("queued messages use the standard icon-button glyph", () => {
	let markup = renderToStaticMarkup(
		createElement(Transcript, {
			active: true,
			entries: [],
			handle: "ana",
			onWithdraw: () => {},
			queued: [{ handle: "ana", id: "queued", text: "One more thought" }],
		}),
	);

	expect(markup).toMatch(/aria-label="Withdraw queued message"[^>]*>.*?height="14"/s);
	expect(markup).toMatch(/aria-label="Withdraw queued message"[^>]*>.*?width="14"/s);
	expect(markup).toContain("<title>xmark</title>");
	expect(markup).not.toContain(">×</button>");
});
