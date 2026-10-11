// packages/editor/src/deck.test.tsx
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Deck, deckAnnouncement, deckKey, parseMs } from "./deck";

function markup(settled: string[] = []) {
	return renderToStaticMarkup(createElement(Deck, {
		label: "3 decisions",
		reduced: () => true,
		items: ["a", "b", "c"].map(id => ({
			id,
			settled: settled.includes(id),
			label: `Header ${id}`,
			card: createElement("article", { "aria-label": "Decision" }, `Card ${id}`),
		})),
	}));
}

describe("deck semantics", () => {
	it("names itself as a carousel of decisions without adding a landmark", () => {
		let html = markup();
		expect(html).toContain('aria-roledescription="carousel"');
		expect(html).toContain('aria-label="3 decisions"');
		expect(html).toContain('role="group"');
		expect(html).not.toContain('role="region"');
		expect(html).toContain('aria-roledescription="decision"');
		expect(html).toContain('aria-label="1 of 3: Header a"');
	});

	it("leaves only the top card interactive", () => {
		let html = markup();
		expect(html.match(/inert=""/g)?.length).toBe(2);
		expect(html.match(/data-deck-top=""/g)?.length).toBe(1);
	});

	it("offers previous and next controls and a count", () => {
		let html = markup(["a"]);
		expect(html).toContain('aria-label="Previous decision"');
		expect(html).toContain('aria-label="Next decision"');
		expect(html.replace(/<[^>]*>|<!-- -->/g, "")).toContain("1 of 3 · 1 decided");
	});

	it("starts with open cards in front", () => {
		expect(markup(["a"])).toMatch(/data-deck-slot="b" data-deck-top=""/);
	});
});

describe("deck keyboard", () => {
	it("cycles only from the deck's own controls and slots", () => {
		expect(deckKey("ArrowRight", "control")).toBe(1);
		expect(deckKey("ArrowLeft", "slot")).toBe(-1);
		expect(deckKey("ArrowRight", "other")).toBeUndefined();
		expect(deckKey("Enter", "control")).toBeUndefined();
	});

	it("ignores modified arrows", () => {
		for (let modifier of ["alt", "ctrl", "meta", "shift"]) {
			expect(deckKey("ArrowRight", "control", { [modifier]: true })).toBeUndefined();
		}
	});
});

describe("deck announcements", () => {
	it("says where the reader is", () => {
		expect(deckAnnouncement("cycle", 2, 3, "Scope")).toBe("Decision 2 of 3: Scope");
		expect(deckAnnouncement("settle", 2, 3, "Scope"))
			.toBe("Decided. Now showing 2 of 3: Scope");
	});
});

describe("deck time tokens", () => {
	it("reads milliseconds and seconds, as a minified build may emit either", () => {
		expect(parseMs("600ms", 1)).toBe(600);
		expect(parseMs(".6s", 1)).toBe(600);
		expect(parseMs("0.45s", 1)).toBe(450);
		expect(parseMs("", 600)).toBe(600);
		expect(parseMs("600", 1)).toBe(600);
		expect(parseMs("0s", 1)).toBe(0);
		expect(parseMs("calc(var(--x) * 2)", 600)).toBe(600);
	});
});
