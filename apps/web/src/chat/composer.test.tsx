import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatComposer } from "./composer";

import type { ChatComposerProps } from "./composer";

/** The markup, with the apostrophe React escapes in text written back, so copy reads as typed. */
function render(props: Partial<ChatComposerProps> = {}): string {
	return renderToStaticMarkup(createElement(ChatComposer, {
		agent: true,
		draftable: true,
		onSubmit: () => {},
		sendDisabled: false,
		sending: false,
		input: {
			mentions: [],
			onChange: () => {},
			onSelect: () => {},
			references: [],
			resetKey: 0,
			value: "",
		},
		...props,
	})).replaceAll("&#x27;", "'");
}

test("renders the draft as a combobox in the field", () => {
	let markup = render();
	expect(markup).toContain('class="composer-surface field"');
	expect(markup).toContain('role="combobox"');
	expect(markup).toContain('aria-label="Message"');
	expect(markup).toContain("Message your collaborators…");
	expect(markup).not.toContain("composer-notice");
	expect(markup).not.toContain('data-planner="off"');
});

test("a failed send alerts above the field and describes the draft", () => {
	let markup = render({
		notice: {
			tone: "error",
			text: "Message not sent.",
			action: { label: "Retry", onClick: () => {} },
		},
	});
	expect(markup).toMatch(
		/<div class="composer-notice motion-feedback"[^>]*role="alert"[^>]*data-error="true"/,
	);
	expect(markup).toContain('class="btn btn-sm btn-outline-danger"');
	expect(markup).toContain('aria-invalid="true"');
	let cue = markup.match(/role="alert" data-error="true" id="([^"]+)"/)![1]!;
	expect(markup).toContain(`aria-describedby="${cue}"`);
});

test("an informational notice is a status with a ghost action", () => {
	let markup = render({
		agent: false,
		notice: { tone: "info", text: "Chopin unavailable" },
	});
	expect(markup).toContain('data-planner="off"');
	expect(markup).toMatch(/<div class="composer-notice" role="status"/);
	expect(markup).not.toContain("btn-outline-danger");
});

test("read-only and archived documents replace the draft and hide notices", () => {
	let readonly = render({ unavailable: "readonly", notice: { tone: "info", text: "Hidden" } });
	expect(readonly).toContain("Read-only access");
	expect(readonly).not.toContain("Hidden");
	expect(readonly).not.toContain('role="combobox"');
	expect(render({ unavailable: "archived" })).toContain("Document archived");
});

test("shows one run control, and no connection state of its own", () => {
	let markup = render({ run: { action: "stop", disabled: false, onClick: () => {} } });
	expect(markup).toContain('aria-label="Stop Chopin"');
	expect(markup).not.toContain('aria-label="Resume Chopin"');
	// The document says when the connection is lost, once, at the top of its content.
	expect(markup).not.toContain("composer-connection");
	expect(markup).not.toContain("Reconnect");
	expect(markup).not.toContain("Retry");
});

test("puts nothing beneath the composer, whatever the Planner is doing", () => {
	let markup = render({
		notice: {
			tone: "warning",
			text: "Can't connect to Build box.",
			link: { label: "How to fix", href: "https://example.test/fix" },
		},
	});
	expect(markup.endsWith("</div></div></div>")).toBe(true);
	expect(markup.lastIndexOf("composer-notice")).toBeLessThan(markup.indexOf("composer-surface"));
	// The composer has no slot for anything under it.
	expect(render()).not.toContain("composer-planner");
});

test("a warning is an alert on the composer's top edge: the words, a link, and what a screen reader adds", () => {
	let markup = render({
		notice: {
			tone: "warning",
			text: "Can't connect to Build box.",
			detail: ["The reason", "Tried 3 times, last at 6:29 PM. Still trying."],
			link: { label: "How to fix", href: "https://example.test/fix" },
		},
	});
	expect(markup).toMatch(/<div class="composer-notice" role="alert" data-warning="true"/);
	expect(markup).toContain("composer-notice-icon");
	expect(markup).toContain("Can't connect to Build box.");
	// Each line stays its own, so nothing is joined to the reason or ended for it.
	expect(markup).toContain(
		'<span class="sr-only"><span class="composer-notice-line">The reason</span>'
			+ '<span class="composer-notice-line">Tried 3 times, last at 6:29 PM. Still trying.</span></span>',
	);
	expect(markup).toContain(
		'<a class="composer-notice-link" href="https://example.test/fix" rel="noreferrer" target="_blank">How to fix</a>',
	);
	// A warning is not a failed send: the field is not invalid and nothing offers Retry.
	expect(markup).not.toContain("aria-invalid");
	expect(markup).not.toContain("btn-outline-danger");
	// It eases open and shut in the shared collapse track, above the field.
	expect(markup).toMatch(
		/<div class="composer-notice-slot motion-collapse is-open"><div class="motion-collapse-content">/,
	);
	expect(markup.indexOf("composer-notice-slot")).toBeLessThan(markup.indexOf("composer-surface"));
});

test("a strip whose lines are shown draws each exactly as supplied, on a line of its own", () => {
	let reason = "  path ends in a slash /  ";
	let markup = render({
		notice: {
			tone: "warning",
			text: "Can't connect to @mona's machine.",
			detail: [reason, "Tried 3 times, last at 6:29 PM. Still trying."],
			showDetail: true,
			link: { label: "How to fix", href: "https://example.test/fix" },
		},
	});
	expect(markup).toContain(`<span class="composer-notice-line">${reason}</span>`);
	expect(markup).toContain(
		'<span class="composer-notice-line">Tried 3 times, last at 6:29 PM. Still trying.</span>',
	);
	// Drawn, so not repeated for a screen reader.
	expect(markup).not.toContain('<span class="sr-only">');
	// The words, the lines, then the link.
	expect(markup.indexOf("Can't connect")).toBeLessThan(markup.indexOf("composer-notice-line"));
	expect(markup.lastIndexOf("composer-notice-line")).toBeLessThan(
		markup.indexOf("composer-notice-link"),
	);
});

test("a strip another live region announces carries no live role of its own", () => {
	for (let tone of ["warning", "info"] as const) {
		let markup = render({ notice: { tone, text: "Connecting to Build box", silent: true } });
		let strip = /<div class="composer-notice"[^>]*>/.exec(markup)![0];
		expect(strip).not.toContain("role=");
		expect(strip).toContain(`id="`);
	}
	// A failed send still alerts, and is never silent.
	expect(render({ notice: { tone: "error", text: "Message not sent." } })).toContain(
		'role="alert"',
	);
});

test("a failed send is shown at once, not in the easing track", () => {
	let markup = render({ notice: { tone: "error", text: "Message not sent." } });
	expect(markup).toContain('class="composer-notice motion-feedback"');
	expect(markup).not.toContain("composer-notice-slot");
});

test("an information strip eases like a warning, and stays a polite status", () => {
	let markup = render({
		notice: { tone: "info", text: "No machine is connected." },
	});
	expect(markup).toMatch(/<div class="composer-notice" role="status"/);
	expect(markup).toContain("composer-notice-slot motion-collapse is-open");
});

test("a read-only document replaces the strip, whatever it was saying", () => {
	let markup = render({
		unavailable: "readonly",
		notice: { tone: "warning", text: "Can't connect to Build box." },
	});
	expect(markup).not.toContain("Can't connect");
	expect(markup).not.toContain("composer-notice");
});
