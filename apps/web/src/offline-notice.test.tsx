import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OFFLINE_MESSAGE, OfflineNotice, OfflineNoticeBody } from "./offline-notice";

test("says what happened and what is kept, as a warning in flow, with no way to act yet", () => {
	let markup = renderToStaticMarkup(createElement(OfflineNoticeBody, {}));
	expect(OFFLINE_MESSAGE).toBe(
		"You’re offline. Your changes are kept and will sync when you reconnect.",
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

test("is not drawn while the connection is fine, though its polite announcement is mounted", () => {
	let markup = renderToStaticMarkup(
		createElement(OfflineNotice, { failures: 0, lost: false, onRetry: () => {} }),
	);
	expect(markup).not.toContain("data-offline-notice");
	expect(markup).not.toContain('role="alert"');
	expect(markup).toMatch(/<span[^>]*aria-live="polite"[^>]*role="status"[^>]*><\/span>/);
});

test("waits out a blip: a loss that has only just begun draws nothing yet", () => {
	let markup = renderToStaticMarkup(
		createElement(OfflineNotice, { failures: 9, lost: true, onRetry: () => {} }),
	);
	expect(markup).not.toContain("data-offline-notice");
	expect(markup).not.toContain("Retry");
});
