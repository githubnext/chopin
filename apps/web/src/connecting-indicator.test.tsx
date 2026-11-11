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

test("the connecting indicator is three dots in an icon's 16px box, hidden from assistive technology", () => {
	let markup = renderToStaticMarkup(createElement(ConnectingIndicator));
	expect(markup).toMatch(/^<svg aria-hidden="true" class="connecting-indicator"/);
	expect(markup).toContain('width="16"');
	expect(markup).toContain('height="16"');
	expect(markup.match(/<circle /g)).toHaveLength(3);
	// Decoration only: no words, no role, nothing focusable, so the status is said by text alone.
	expect(markup).not.toContain("role=");
	expect(markup).not.toContain("<title");
	expect(markup).toContain('focusable="false"');
	expect(renderToStaticMarkup(createElement(ConnectingIndicator, { className: "x" })))
		.toContain('class="connecting-indicator x"');
});

test("the banner draws the indicator only while it reconnects or connects, beside its words", () => {
	let reconnecting = renderToStaticMarkup(
		createElement(ConnectionState, { attempt: 2, phase: "reconnecting" }),
	);
	expect(indicators(reconnecting)).toBe(1);
	// It sits in the icon's place, with the icon's classes, and the words are still text.
	expect(reconnecting).toContain(
		'class="connecting-indicator composer-notice-icon icon-first-line"',
	);
	expect(reconnecting).toContain("Reconnecting. Your changes are kept.");
	expect(reconnecting).not.toContain("composer-notice-spin");
	let connecting = renderToStaticMarkup(
		createElement(ConnectionState, {
			layer: "planner",
			message: "Connecting to build-box",
			phase: "reconnecting",
		}),
	);
	expect(indicators(connecting)).toBe(1);
	expect(connecting).toContain("Connecting to build-box");
	// Every other phase keeps its own icon.
	for (let phase of ["dropped", "resumed"] as const) {
		expect(indicators(renderToStaticMarkup(createElement(ConnectionState, { phase })))).toBe(0);
	}
	expect(renderToStaticMarkup(createElement(ConnectionState, { phase: "online" }))).toBe("");
});

test("the machine button's badge draws the indicator only while its Planner starts", () => {
	let machine = { service: false, connected: true, reauthorize: false };
	let starting = renderToStaticMarkup(
		createElement(MachineGlyph, { machine, planner: "starting" }),
	);
	expect(indicators(starting)).toBe(1);
	expect(starting).toMatch(
		/<span class="status-dot machine-glyph-dot" data-planner="starting"><svg aria-hidden="true" class="connecting-indicator"/,
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
