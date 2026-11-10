import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";

import { ConnectionAnnouncement } from "./chat/connection-banner";
import { OFFLINE_MESSAGE } from "./chat/connection-phase";
import { ConnectionState } from "./chat/connection-state";
import { ErrorState } from "./chat/error-state";
import { DocumentBanner, documentTells } from "./document-banner";

import type { ConnectionView } from "./chat/connection-phase";

/** Markup with the apostrophe React escapes in text written back, so copy reads as typed. */
function renderToStaticMarkup(element: Parameters<typeof render>[0]): string {
	return render(element).replaceAll("&#x27;", "'");
}

const DROPPED: ConnectionView = {
	phase: "dropped",
	layer: "socket",
	text: OFFLINE_MESSAGE,
	action: "reconnect",
};

test("the connection banner shows nothing while online, and says each phase once it is not", () => {
	expect(renderToStaticMarkup(createElement(ConnectionState, { phase: "online" }))).toBe("");
	let dropped = renderToStaticMarkup(createElement(ConnectionState, { phase: "dropped" }));
	// The user's words, character for character, with plain apostrophes.
	expect(OFFLINE_MESSAGE).toBe(
		"You're offline. Your changes are kept and will sync when you reconnect.",
	);
	expect(dropped).toContain(OFFLINE_MESSAGE);
	expect(dropped).toContain('data-phase="dropped"');
	let reconnecting = renderToStaticMarkup(
		createElement(ConnectionState, { attempt: 3, phase: "reconnecting" }),
	);
	expect(reconnecting).toContain('data-phase="reconnecting"');
	expect(reconnecting).toContain(">attempt 3</span>");
	let resumed = renderToStaticMarkup(
		createElement(ConnectionState, {
			caught: "2 new messages",
			message: "Back. The reply kept going.",
			phase: "resumed",
		}),
	);
	expect(resumed).toContain("Back. The reply kept going.");
	expect(resumed).toContain(">2 new messages</span>");
});

test("Reconnect is drawn only where there is something to retry, as a secondary outline action", () => {
	let none = renderToStaticMarkup(createElement(ConnectionState, { phase: "dropped" }));
	expect(none).not.toContain("<button");
	let withRetry = renderToStaticMarkup(
		createElement(ConnectionState, { onRetry: () => {}, phase: "dropped" }),
	);
	expect(withRetry).toContain('class="btn btn-xs btn-outline"');
	expect(withRetry).toContain(">Reconnect</button>");
	expect(withRetry).not.toContain("btn-primary");
	// A phase that is not dropped has no button, whatever it was given.
	expect(
		renderToStaticMarkup(
			createElement(ConnectionState, { onRetry: () => {}, phase: "reconnecting" }),
		),
	).not.toContain("<button");
});

test("the banner is no live region of its own: one polite region says each phase once", () => {
	let markup = renderToStaticMarkup(createElement(ConnectionState, { phase: "dropped" }));
	expect(markup).not.toContain("aria-live");
	expect(markup).not.toContain('role="alert"');
	expect(markup).not.toContain('role="status"');
	expect(renderToStaticMarkup(createElement(ConnectionAnnouncement, { spoken: "" }))).toMatch(
		/<span[^>]*aria-live="polite"[^>]*role="status"[^>]*><\/span>/,
	);
	expect(
		renderToStaticMarkup(createElement(ConnectionAnnouncement, { spoken: "Back online." })),
	).toContain(">Back online.</span>");
});

test("the failure banner alerts with a Retry, or is one quiet status line while it retries", () => {
	let failed = renderToStaticMarkup(
		createElement(ErrorState, {
			detail: "429 Too Many Requests",
			onRetry: () => {},
			title: "Couldn't finish the reply.",
		}),
	);
	expect(failed).toContain('role="alert"');
	expect(failed).toContain("Couldn't finish the reply.");
	expect(failed).toContain("429 Too Many Requests");
	expect(failed).toContain("btn btn-xs btn-outline-danger");
	let retrying = renderToStaticMarkup(createElement(ErrorState, { retrying: true, title: "x" }));
	expect(retrying).toContain('role="status"');
	expect(retrying).toContain("Retrying");
	expect(retrying).not.toContain("<button");
	// Nothing to retry, no button.
	expect(renderToStaticMarkup(createElement(ErrorState, { title: "x" }))).not.toContain("<button");
});

test("the document draws the room's connection, and leaves the machine's to Chat's composer", () => {
	expect(documentTells(DROPPED)).toBe(true);
	expect(documentTells({ phase: "online" })).toBe(false);
	expect(documentTells({ phase: "resumed", text: "Back online.", caught: "x" })).toBe(true);
	expect(
		documentTells({ phase: "dropped", layer: "planner", text: "Build box is offline." }),
	).toBe(false);
	expect(
		renderToStaticMarkup(
			createElement(DocumentBanner, {
				onRetry: undefined,
				view: { phase: "dropped", layer: "planner", text: "Build box is offline." },
			}),
		),
	).toBe("");
	let drawn = renderToStaticMarkup(
		createElement(DocumentBanner, { onRetry: () => {}, view: DROPPED }),
	);
	expect(drawn).toContain("data-document-banner");
	expect(drawn).toContain(">Reconnect</button>");
});
