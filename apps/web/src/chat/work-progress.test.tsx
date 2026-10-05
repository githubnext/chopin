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
	expect(markup).toContain("Details");
	expect(markup).not.toContain("&lt;unsafe&gt;");
});

test("completed work names action and tool-time totals", () => {
	let markup = renderToStaticMarkup(createElement(WorkProgress, {
		active: false,
		responseSeen: true,
		streaming: false,
		tools: [
			{ id: "one", name: "read_plan", status: "done", took: 38 },
			{ id: "two", name: "edit_plan", status: "failed", took: 1_200 },
		],
	}));

	expect(markup).toContain("Work details");
	expect(markup).toContain("2 actions");
	expect(markup).toContain("1 failed");
	expect(markup).toContain("1.2s tool time");
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
