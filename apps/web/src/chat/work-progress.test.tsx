import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkProgress } from "./work-progress";

test("active work exposes a stage and keeps tool details collapsed", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: true,
		responseSeen: false,
		streaming: false,
		tools: [{
			id: "tool-1",
			name: "read_plan",
			status: "running",
			args: '{ "path": "<unsafe>" }',
		}],
	}));

	expect(markup).toContain("Gathering context");
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).toContain('data-status="running"');
	expect(markup).not.toContain("&lt;unsafe&gt;");
});

test("completed work shows its time and names its tools and failures for screen readers", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: false,
		responseSeen: true,
		streaming: false,
		tools: [
			{ id: "one", name: "read_plan", status: "done", took: 38 },
			{ id: "two", name: "edit_plan", status: "failed", took: 1_200 },
		],
	}));

	expect(markup).toContain('<span class="sr-only">Used 2 tools in 1s, 1 failed</span>');
	expect(markup).toMatch(/data-slot="trace-title"[^>]*>1s</);
	expect(markup).not.toContain("38ms");
	expect(markup).toContain('aria-hidden="true" class="work-summary"');
	expect(markup).not.toContain("Work details");
	expect(markup).not.toContain("tool time");
});

test("active work counts failed calls as finished rather than done", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: true,
		responseSeen: false,
		streaming: false,
		tools: [
			{ id: "one", name: "read_plan", status: "done" },
			{ id: "two", name: "edit_plan", status: "failed" },
		],
	}));

	expect(markup).toContain("2 finished");
	expect(markup).not.toContain("2 done");
});

test("disconnected work stays inspectable without claiming an active or interrupted call", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: false,
		disconnected: true,
		responseSeen: true,
		streaming: false,
		tools: [{ id: "one", name: "read_plan", status: "running", args: "{}" }],
	}));

	expect(markup).toContain("Used 1 tool, connection lost");
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).not.toContain("trace-scribble");
	expect(markup).not.toContain("Interrupted");
	expect(markup).not.toContain("interrupted");
});

test("an active ask preserves the static decision wait while keeping tool details", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: true,
		responseSeen: true,
		streaming: false,
		tools: [{
			id: "ask",
			name: "ask",
			status: "running",
			args: JSON.stringify({ questions: [{ question: "Which database?" }] }),
		}],
	}));
	expect(markup).toContain("Waiting on your decision");
	expect(markup).toContain("data-tool-waiting");
	expect(markup).not.toContain("trace-scribble");
	expect(markup).not.toContain('data-status="running"');
	expect(markup).toContain('aria-expanded="false"');
});

test("finished work with a failure marks only the failed kind", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: false,
		responseSeen: true,
		streaming: false,
		tools: [{ id: "one", name: "edit_plan", status: "failed", took: 12 }],
	}));

	expect(markup).toContain('class="work-summary-chip" data-failed="true"');
	expect(markup).toContain('class="work-summary-failed"');
	expect(markup).not.toContain('data-status="error"');
	expect(markup).toContain('data-slot="trace-collapsible-trigger"');
});

test("interrupted work counts its stopped call", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: false,
		responseSeen: true,
		streaming: false,
		tools: [
			{ id: "one", name: "read_plan", status: "done" },
			{ id: "two", name: "edit_plan", status: "running" },
		],
	}));

	expect(markup).toContain("Used 2 tools, 1 interrupted");
	expect(markup).toContain('class="work-summary-stopped"');
});
