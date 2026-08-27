import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanChanges } from "./changes-chip";

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
