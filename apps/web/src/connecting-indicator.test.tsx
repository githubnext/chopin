import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";

import { ConnectionState } from "./chat/connection-state";
import { ConnectingIndicator } from "./connecting-indicator";
import { MachineGlyph } from "./machine-button";

/** Markup with the apostrophe React escapes in text written back, so copy reads as typed. */
function renderToStaticMarkup(element: Parameters<typeof render>[0]): string {
	return render(element).replaceAll("&#x27;", "'");
}

/** How many connecting indicators a piece of markup draws. */
function indicators(markup: string): number {
	return markup.match(/data-connecting=""/g)?.length ?? 0;
}

test("the connecting indicator is three dots drawn by CSS, hidden from assistive technology", () => {
	let markup = renderToStaticMarkup(createElement(ConnectingIndicator));
	expect(markup).toBe(
		'<span aria-hidden="true" class="connecting-indicator" data-connecting="">'
			+ '<span class="connecting-dot"></span>'.repeat(3)
			+ "</span>",
	);
	// Decoration only: no words, no role, nothing focusable, so the status is said by text alone.
	expect(renderToStaticMarkup(createElement(ConnectingIndicator, { className: "x" })))
		.toContain('class="connecting-indicator x"');
});

test("the offline bar draws the indicator only while it reconnects, beside its words", () => {
	let reconnecting = renderToStaticMarkup(
		createElement(ConnectionState, { phase: "reconnecting" }),
	);
	expect(indicators(reconnecting)).toBe(1);
	// It sits in the icon's place, and the words are still text.
	expect(reconnecting).toContain('class="connecting-indicator offline-bar-icon"');
	expect(reconnecting).toContain("Connecting\u2026 Your changes are kept.");
	// Offline keeps its warning icon, and coming back and being online draw nothing.
	expect(
		indicators(renderToStaticMarkup(createElement(ConnectionState, { phase: "dropped" }))),
	).toBe(0);
	for (let phase of ["online", "resumed"] as const) {
		expect(renderToStaticMarkup(createElement(ConnectionState, { phase }))).toBe("");
	}
});

test("the machine button's badge draws the indicator only while its Planner starts", () => {
	let machine = { service: false, connected: true, reauthorize: false };
	let starting = renderToStaticMarkup(
		createElement(MachineGlyph, { machine, planner: "starting" }),
	);
	expect(indicators(starting)).toBe(1);
	expect(starting).toMatch(
		/<span class="status-dot machine-glyph-dot" data-planner="starting"><span aria-hidden="true" class="connecting-indicator"/,
	);
	// The glyph as a whole stays decoration; the button's name says what is connecting.
	expect(starting).toMatch(/^<span aria-hidden="true" class="machine-glyph"/);
	for (let planner of ["failing", "away", "none", undefined] as const) {
		let markup = renderToStaticMarkup(createElement(MachineGlyph, { machine, planner }));
		expect(indicators(markup)).toBe(0);
	}
	// Away and a warning keep their plain dots.
	expect(renderToStaticMarkup(createElement(MachineGlyph, { machine, planner: "away" })))
		.toContain('<span class="status-dot machine-glyph-dot" data-planner="away"></span>');
});
