import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageByModelSection } from "./usage-by-model";

import type { UsageByModelState } from "./usage-by-model";

function render(state: UsageByModelState) {
	return renderToStaticMarkup(createElement(UsageByModelSection, { state, onRetry() {} }));
}

function text(html: string) {
	return html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
}

test("lists each model's requests, errors and tokens, most requested first, with pending and unknown requests apart", () => {
	let html = render({
		phase: "loaded",
		usage: {
			since: "2026-10-02T12:00:00.000Z",
			models: [
				{
					provider: "anthropic",
					model: "claude-test",
					requests: 1_204,
					errors: 3,
					pending: 1,
					unknown: 2,
					tokens: { input: 1_520_000, output: 48_200, cacheRead: 900, cacheWrite: 0 },
				},
				{
					provider: "openai",
					requests: 4,
					errors: 0,
					pending: 0,
					unknown: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		},
	});
	expect(html).toContain("<h2");
	expect(text(html)).toContain(
		"Model Requests Errors Input Output Cache read Cache write "
			+ "claude-test Anthropic 1,204 1 pending 2 unknown 3 1.5M 48.2K 900 0 "
			+ "Other requests OpenAI 4 0 0 0 0 0",
	);
});

test("says when there were no requests, and offers Retry when the totals couldn't load", () => {
	expect(text(render({ phase: "loaded", usage: { since: "", models: [] } }))).toContain(
		"No requests in the last 7 days.",
	);
	let failed = render({ phase: "failed" });
	expect(failed).toContain('role="alert"');
	expect(text(failed)).toContain("Chopin couldn't load your usage. Retry");
	expect(render({ phase: "loading" })).toContain('aria-busy="true"');
});
