import type { Research } from "./research";

/** Experimental per-document delegation. No existing document is opted in. */
export declare namespace Agenda {
	export type State = "paused" | "active" | "stopped" | "failed";
	export type StopReason =
		| "human-paused"
		| "scope-changed"
		| "restart"
		| "owner-unavailable"
		| "capability-unavailable"
		| "expired"
		| "budget-exhausted"
		| "investigations-complete"
		| "evidence-sufficient"
		| "nothing-useful"
		| "assessment-failed"
		| "research-failed"
		| "research-cancelled"
		| "research-timeout"
		| "document-unavailable";
	export type QuestionInput = {
		question: string;
		reason: string;
		evidenceNeed: string;
		priority: number;
	};
	export type Question = QuestionInput & {
		id: string;
		state: "queued" | "running" | "completed" | "skipped" | "cancelled" | "failed";
		requestId?: string;
		request?: Research.RequestView;
	};
	export type Limits = {
		maxQuestions: number;
		maxInvestigations: number;
		maxAiCredits: number;
		maxAssessments: number;
		minIntervalMs: number;
		durationMs: number;
		requestTimeoutMs: number;
	};
	export type View = {
		channelId: string;
		revision: number;
		generation: number;
		scope: string;
		state: State;
		stopReason?: StopReason;
		questions: Question[];
		delegatedBy?: string;
		expiresAt?: string;
		nextRunAt?: string;
		investigations: number;
		reservedAiCredits: number;
		assessments: number;
		updatedAt: string;
	};
	export type Response = {
		agenda: View | null;
		canEdit: boolean;
		available: boolean;
		unavailableReason?: string;
		limits: Limits;
	};
	export type Pause = { expectedGeneration: number };
	export type Save = {
		expectedRevision: number;
		scope: string;
		questions: QuestionInput[];
	};
}
