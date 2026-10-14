import { z } from "zod";

import type { BuildRecommendation, RecommendationEvidence } from "@chopin/protocol/recommendation";
import type { JsonValue } from "../storage/model";

export const MAX_RECOMMENDATION_INPUT_BYTES = 128 * 1024;
export const MAX_RECOMMENDATION_ARTIFACT_BYTES = 32 * 1024;
// Copilot requires at least 30 credits when opening even a single no-tool worker turn.
export const RECOMMENDATION_AI_CREDITS = 30;

export type RecommendationInput = {
	key: string;
	planRevision: number;
	evidence: RecommendationEvidence[];
};

export type RecommendationArtifact = {
	key: string;
	planRevision: number;
	recommendation: BuildRecommendation | null;
	model: string;
};

let text = (max: number) => z.string().trim().min(1).max(max);
let key = z.string().regex(/^sha256:[a-f0-9]{64}$/);
let revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
let evidenceId = z.string().min(1).max(240).refine(value => value.trim() === value);
let distinct = (values: string[]) => new Set(values).size === values.length;
let evidenceSchema = z.object({
	id: evidenceId,
	kind: z.enum(["document", "discussion", "decision", "repository", "investigation", "research"]),
	label: text(200),
	detail: text(6000),
}).strict();

export let recommendationSchema = z.object({
	kind: z.enum(["build", "clarify", "investigate"]),
	title: text(100),
	scope: text(800),
	reasons: z.array(text(350)).min(1).max(3),
	dependencies: z.array(text(350)).max(5),
	optional: z.array(text(350)).max(5),
	evidenceIds: z.array(evidenceId).min(1).max(12).refine(distinct),
	nextAction: text(1000),
}).strict().refine(value => value.kind !== "build" || value.dependencies.length === 0, {
	message: "A proposed build cannot have unresolved dependencies.",
});

export let recommendationOutputSchema = z.object({
	recommendation: recommendationSchema.nullable(),
}).strict();

let inputSchema = z.object({
	key,
	planRevision: revision,
	evidence: z.array(evidenceSchema).max(48).refine(values =>
		distinct(values.map(value => value.id))
	),
}).strict();
let artifactSchema = z.object({
	key,
	planRevision: revision,
	recommendation: recommendationSchema.nullable(),
	model: text(200),
}).strict();

function bounded(value: JsonValue, maximum: number): void {
	if (Buffer.byteLength(JSON.stringify(value)) > maximum) {
		throw new Error("Recommendation data exceeds its byte limit.");
	}
}

export function parseRecommendationInput(value: JsonValue): RecommendationInput {
	bounded(value, MAX_RECOMMENDATION_INPUT_BYTES);
	return inputSchema.parse(value);
}

/** The current input is required at execution, publication and every advisory read. */
export function parseRecommendationArtifact(
	value: JsonValue,
	input?: RecommendationInput,
): RecommendationArtifact {
	bounded(value, MAX_RECOMMENDATION_ARTIFACT_BYTES);
	let parsed = artifactSchema.parse(value);
	if (input) {
		if (parsed.key !== input.key || parsed.planRevision !== input.planRevision) {
			throw new Error("Recommendation does not match its evidence revision.");
		}
		let ids = new Set(input.evidence.map(item => item.id));
		if (parsed.recommendation?.evidenceIds.some(id => !ids.has(id))) {
			throw new Error("Recommendation cites evidence that was not supplied.");
		}
	}
	return parsed;
}
