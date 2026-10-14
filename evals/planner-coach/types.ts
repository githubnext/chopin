export type Turn = { speaker: string; text: string; stopWrites?: boolean };
export type Scenario = {
	id: string;
	title: string;
	source: string;
	turns: Turn[];
	expectations: string[];
	maxQuestions: number;
	requiresEvidence: boolean;
};
export type Limits = { maxTools: number; turnTimeoutMs: number; questionWaitMs: number };
export type Trace = {
	index: number;
	turn: number;
	name: string;
	input: unknown;
	revisionBefore: number;
	revisionAfter?: number;
	output?: unknown;
	error?: string;
	refusal?: string;
	sourceBefore: string;
	sourceAfter?: string;
};
export type TranscriptTurn = {
	number: number;
	human: Turn;
	prompt: string;
	text: string;
	parts: unknown[];
	status: "complete" | "awaiting-human" | "failed";
	durationMs?: number;
	failures: string[];
};
export type Transcript = {
	scenario: Scenario;
	turns: TranscriptTurn[];
	tools: Trace[];
	initialSource: string;
	finalSource: string;
	finalRevision: number;
	activeTools: readonly string[];
	durableDocument?: { source: string; storageRevision: number; matchesLiveSource: boolean };
	failures: string[];
};
import type { createPlannerAgent } from "../../apps/server/src/harness/agents";

export type Harness = Parameters<typeof createPlannerAgent>[0];
export type Tools = NonNullable<
	Parameters<ReturnType<typeof createPlannerAgent>["stream"]>[0]["options"]
>["githubTools"];
