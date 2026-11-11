import { describe, expect, test } from "bun:test";

import { toBreakdownSegments, toComposerUsage } from "./context-usage";

describe("context-usage adapters", () => {
	test("hides context ring and breakdown when usage or contextWindow is absent or zero", () => {
		expect(toComposerUsage(undefined)).toBeUndefined();
		expect(
			toComposerUsage({
				messages: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				contextWindow: 128_000,
			}),
		).toBeUndefined();
		expect(toBreakdownSegments(undefined)).toBeUndefined();
	});

	test("maps raw harness tokens to thousands for ComposerContext and raw segments for ContextBreakdown", () => {
		let usage = {
			messages: 42_000,
			inputTokens: 36_000,
			outputTokens: 6_000,
			cachedTokens: 12_000,
			totalTokens: 42_000,
			contextWindow: 128_000,
		};
		expect(toComposerUsage(usage)).toEqual({
			system: 0,
			tools: 0,
			messages: 42,
			total: 128,
		});
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
