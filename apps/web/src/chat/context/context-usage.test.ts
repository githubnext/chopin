import { describe, expect, test } from "bun:test";

import { toBreakdownSegments } from "./context-usage";

describe("context-usage adapters", () => {
	test("hides the breakdown when usage or contextWindow is absent or zero", () => {
		expect(toBreakdownSegments(undefined)).toBeUndefined();
		expect(
			toBreakdownSegments({
				messages: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				contextWindow: 128_000,
			}),
		).toBeUndefined();
	});

	test("maps raw harness tokens to raw segments for ContextBreakdown", () => {
		let usage = {
			messages: 42_000,
			inputTokens: 36_000,
			outputTokens: 6_000,
			cachedTokens: 12_000,
			totalTokens: 42_000,
			contextWindow: 128_000,
		};
		expect(toBreakdownSegments(usage)).toEqual({
			limit: 128_000,
			segments: [
				{ label: "Cached input", tokens: 12_000, tint: "bg-primary/40" },
				{ label: "Input", tokens: 24_000, tint: "bg-primary/70" },
				{ label: "Output", tokens: 6_000, tint: "bg-primary" },
			],
		});
	});
});
