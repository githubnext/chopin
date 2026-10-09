import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { author, PlanChanges } from "./changes-chip";

import type { ChangeStore, Snapshot } from "./changes";

test("the change-list trigger uses keyed editor feedback for its closed glyph", () => {
	let snapshot: Snapshot = {
		above: 1,
		below: 0,
		entries: [{
			id: "change",
			kind: "added",
			blocks: [{ preview: "A changed paragraph", type: "paragraph" }],
			seen: false,
		}],
	};
	let store = {
		reveal() {},
		snapshot: () => snapshot,
		subscribe: () => () => {},
	} as unknown as ChangeStore;
	let markup = renderToStaticMarkup(createElement(PlanChanges, { store }));

	expect(markup).toContain('data-feedback-icon="closed"');
	expect(markup).toContain('data-motion-feedback="icon"');
	expect(markup).toContain("editor-motion-feedback");
});

function attributed(name: string) {
	return {
		id: "change",
		kind: "added" as const,
		blocks: [],
		seen: true,
		attribution: {
			client: { name, version: "unknown" },
			user: "ana",
			fromRevision: 1,
			revision: 2,
		},
	};
}

test("an MCP change names the verified caller before the client they used", () => {
	expect(author(attributed("unknown"))).toBe("@ana");
	expect(author(attributed("Review bot"))).toBe("@ana via Review bot");
});
