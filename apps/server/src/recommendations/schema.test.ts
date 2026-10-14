import { describe, expect, it } from "bun:test";

import {
	parseRecommendationArtifact,
	parseRecommendationInput,
	recommendationOutputSchema,
} from "./schema";

import type { RecommendationArtifact, RecommendationInput } from "./schema";
import type { BuildRecommendation } from "@chopin/protocol/recommendation";

function input(): RecommendationInput {
	return {
		key: `sha256:${"a".repeat(64)}`,
		planRevision: 3,
		evidence: [{
			id: "discussion:1",
			kind: "discussion",
			label: "Coworker feedback",
			detail: "Can I create an open decision?",
		}],
	};
}

function artifact(): RecommendationArtifact & { recommendation: BuildRecommendation } {
	return {
		key: input().key,
		planRevision: 3,
		model: "fixture",
		recommendation: {
			kind: "clarify",
			title: "Understand the decision creation problem",
			scope: "Improve the decision creation entry point.",
			reasons: ["The feedback identifies an unclear way to create an open decision."],
			dependencies: ["Learn what the coworker was trying to accomplish."],
			optional: ["A broader onboarding flow can remain open."],
			evidenceIds: ["discussion:1"],
			nextAction: "What were you trying to do when you looked for a way to create a decision?",
		},
	};
}

function evidence(count: number, detail: string) {
	return Array.from({ length: count }, (_, index) => ({
		id: `repository:${index}`,
		kind: "repository" as const,
		label: "Observed source",
		detail,
	}));
}

describe("recommendation codecs", () => {
	it("accepts a bounded artifact bound to its evidence revision", () => {
		expect(parseRecommendationInput(input())).toEqual(input());
		expect(parseRecommendationArtifact(artifact(), input())).toEqual(artifact());
	});

	it("accepts abstention only as an explicit null bound to the current context", () => {
		let quiet = { ...artifact(), recommendation: null };
		expect(parseRecommendationArtifact(quiet, input())).toEqual(quiet);
		expect(() =>
			parseRecommendationArtifact({ ...quiet, key: `sha256:${"b".repeat(64)}` }, input())
		)
			.toThrow("revision");
		expect(() => parseRecommendationArtifact({ ...quiet, planRevision: 4 }, input()))
			.toThrow("revision");
		expect(() => parseRecommendationArtifact({ ...quiet, recommendation: false }, input()))
			.toThrow();
		expect(() =>
			parseRecommendationArtifact({
				key: quiet.key,
				planRevision: quiet.planRevision,
				model: quiet.model,
			}, input())
		)
			.toThrow();
	});

	it("structured worker output requires a strict object envelope for advice or abstention", () => {
		expect(recommendationOutputSchema.parse({ recommendation: artifact().recommendation }))
			.toEqual({ recommendation: artifact().recommendation });
		expect(recommendationOutputSchema.parse({ recommendation: null })).toEqual({
			recommendation: null,
		});
		for (
			let invalid of [null, artifact().recommendation, {}, { recommendation: null, approved: true }]
		) {
			expect(() => recommendationOutputSchema.parse(invalid)).toThrow();
		}
	});

	it("rejects unknown capabilities and malformed revision identity", () => {
		for (
			let value of [
				{ ...input(), token: "secret" },
				{ ...input(), key: "not-a-hash" },
				{ ...input(), planRevision: -1 },
				{ ...input(), planRevision: 1.5 },
				{ ...input(), evidence: [{ ...input().evidence[0]!, url: "https://example.com" }] },
			]
		) expect(() => parseRecommendationInput(value)).toThrow();
		expect(() => parseRecommendationArtifact({ ...artifact(), approved: true })).toThrow();
		expect(() =>
			parseRecommendationArtifact({
				...artifact(),
				recommendation: { ...artifact().recommendation, score: 100 },
			})
		).toThrow();
	});

	it("bounds evidence count, per-item text and aggregate UTF-8 bytes", () => {
		expect(() => parseRecommendationInput({ ...input(), evidence: evidence(49, "fact") }))
			.toThrow();
		expect(() => parseRecommendationInput({ ...input(), evidence: evidence(1, "x".repeat(6001)) }))
			.toThrow();
		expect(() => parseRecommendationInput({ ...input(), evidence: evidence(48, "é".repeat(3000)) }))
			.toThrow("byte limit");
		expect(parseRecommendationInput({ ...input(), evidence: evidence(48, "fact") }).evidence)
			.toHaveLength(48);
	});

	it("rejects duplicate and invented evidence IDs", () => {
		expect(() =>
			parseRecommendationInput({
				...input(),
				evidence: [input().evidence[0]!, input().evidence[0]!],
			})
		).toThrow();
		let recommendation = artifact().recommendation;
		expect(() =>
			parseRecommendationArtifact({
				...artifact(),
				recommendation: { ...recommendation, evidenceIds: ["invented"] },
			}, input())
		).toThrow("not supplied");
		expect(() =>
			parseRecommendationArtifact({
				...artifact(),
				recommendation: { ...recommendation, evidenceIds: ["discussion:1", "discussion:1"] },
			})
		).toThrow();
		expect(() =>
			parseRecommendationArtifact({
				...artifact(),
				recommendation: { ...recommendation, evidenceIds: [] },
			})
		).toThrow();
	});

	it("rejects an artifact from another context or revision", () => {
		expect(() =>
			parseRecommendationArtifact({ ...artifact(), key: `sha256:${"b".repeat(64)}` }, input())
		).toThrow("revision");
		expect(() => parseRecommendationArtifact({ ...artifact(), planRevision: 4 }, input())).toThrow(
			"revision",
		);
	});

	it("a build may keep broader exploration optional but cannot have prerequisites", () => {
		let recommendation = { ...artifact().recommendation, kind: "build" as const, dependencies: [] };
		expect(
			parseRecommendationArtifact({ ...artifact(), recommendation }, input()).recommendation
				?.optional,
		).toHaveLength(1);
		expect(() =>
			parseRecommendationArtifact({
				...artifact(),
				recommendation: { ...recommendation, dependencies: ["Unknown necessary behavior"] },
			})
		).toThrow("unresolved dependencies");
	});

	it("enforces concise output limits and nonempty reasons", () => {
		let recommendation = artifact().recommendation;
		for (
			let changed of [
				{ title: "x".repeat(101) },
				{ scope: "x".repeat(801) },
				{ reasons: [] },
				{ reasons: Array(4).fill("reason") },
				{ reasons: ["x".repeat(351)] },
				{ dependencies: Array(6).fill("dependency") },
				{ optional: Array(6).fill("question") },
				{ nextAction: "x".repeat(1001) },
			]
		) {
			expect(() =>
				parseRecommendationArtifact({
					...artifact(),
					recommendation: { ...recommendation, ...changed },
				})
			).toThrow();
		}
	});
});
