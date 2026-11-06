import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";

import {
	OFFLINE_MESSAGE,
	OfflineAnnouncement,
	OfflineNotice,
	OfflineNoticeBody,
} from "./offline-notice";

/** Markup with the apostrophe React escapes in text written back, so copy reads as typed. */
function renderToStaticMarkup(element: Parameters<typeof render>[0]): string {
	return render(element).replaceAll("&#x27;", "'");
}

test("says what happened and what is kept, as a warning in flow, with no way to act yet", () => {
	let markup = renderToStaticMarkup(createElement(OfflineNoticeBody, {}));
	// The user's words, character for character, with plain apostrophes.
	expect(OFFLINE_MESSAGE).toBe(
		"You're offline. Your changes are kept and will sync when you reconnect.",
	);
	expect(markup).toContain('role="alert"');
	expect(markup).toContain('data-tone="warning"');
	expect(markup).toContain(OFFLINE_MESSAGE);
	expect(markup).not.toContain("<button");
});

test("offers Retry as a secondary outline action, and only when asked to", () => {
	let markup = renderToStaticMarkup(createElement(OfflineNoticeBody, { onRetry: () => {} }));
	expect(markup).toContain('class="btn btn-xs btn-outline"');
	expect(markup).toContain(">Retry</button>");
	expect(markup).not.toContain("btn-primary");
});

test("is not drawn while the connection is fine", () => {
	let markup = renderToStaticMarkup(
		createElement(OfflineNotice, { open: false, retry: false, onRetry: () => {} }),
	);
	expect(markup).toBe("");
});

test("is simply there, at once and silent, when it is mounted again somewhere else during one outage", () => {
	// What a person switching between Chat and the document does: the page decided the notice was
	// due once, above both places, so the one drawn after the switch is open from its first frame.
	let markup = renderToStaticMarkup(
		createElement(OfflineNotice, { open: true, retry: true, onRetry: () => {} }),
	);
	expect(markup).toContain("data-offline-notice");
	expect(markup).toContain("motion-collapse is-open");
	expect(markup).not.toContain("is-closing");
	expect(markup).toContain(">Retry</button>");
	// It holds no announcement of its own to say again: that is the page's one polite region.
	expect(markup).not.toContain("aria-live");
	expect(markup).not.toContain('role="status"');
});

test("leaves its one polite word to a single region, empty until the notice has gone", () => {
	expect(renderToStaticMarkup(createElement(OfflineAnnouncement, { spoken: "" }))).toMatch(
		/<span[^>]*aria-live="polite"[^>]*role="status"[^>]*><\/span>/,
	);
	expect(
		renderToStaticMarkup(createElement(OfflineAnnouncement, { spoken: "Reconnected" })),
	).toContain(">Reconnected</span>");
});
