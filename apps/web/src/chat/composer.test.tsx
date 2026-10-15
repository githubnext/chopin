import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatComposer } from "./composer";

import type { ChatComposerProps } from "./composer";

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
	}));
}

test("renders the draft as a combobox in the field", () => {
	let markup = render();
	expect(markup).toContain('class="composer-surface field"');
	expect(markup).toContain('role="combobox"');
	expect(markup).toContain('aria-label="Message"');
	expect(markup).toContain("Message…");
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

test("shows the connection, Reconnect, and one run control", () => {
	let markup = render({
		connectionLabel: "Offline",
		onReconnect: () => {},
		run: { action: "stop", disabled: false, onClick: () => {} },
	});
	expect(markup).toContain('data-offline="true"');
	expect(markup).toContain("Reconnect");
	expect(markup).toContain('aria-label="Stop Chopin"');
	expect(markup).not.toContain('aria-label="Resume Chopin"');
});
