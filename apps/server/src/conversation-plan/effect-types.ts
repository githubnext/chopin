import type { ConversationPlan } from "@chopin/protocol";
// Extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.ts.

export type JobIntent = {
	kind: "heading" | "refine" | "suggest" | "prose";
	target: string;
	trigger: string;
};

export type Effect =
	| {
		key: string;
		kind: "insert-card";
		threadId: string;
		header: string;
		question: string;
		options: Array<{ id: string; label: string; source?: ConversationPlan.SourceRef }>;
		trigger: string;
	}
	| {
		key: string;
		kind: "add-option";
		threadId: string;
		optionId: string;
		label: string;
		trigger: string;
		source?: ConversationPlan.SourceRef;
	}
	| {
		key: string;
		kind: "suggest";
		threadId: string;
		optionId?: string;
		messageIds: string[];
	}
	| {
		key: string;
		kind: "prompt";
		threadId: string;
		optionId?: string;
		messageId: string;
		generation: number;
		/** Absent on legacy outbox entries; present for source-aware prompt deduplication. */
		sourceMessageIds?: string[];
	}
	| {
		key: string;
		kind: "defer-prompt";
		threadId: string;
		proposalId: string;
		deferredEventId: string;
	}
	| {
		key: string;
		kind: "scoped-choice";
		threadId: string;
		proposalId: string;
		cardId: string;
		optionId: string;
		label: string;
		scope: "spike";
		generation: number;
		triggerEventId: string;
		sources: ConversationPlan.SourceRef[];
	}
	| { key: string; kind: "research"; offerId: string }
	| { key: string; kind: "job"; intent: JobIntent; threadId?: string };

export type CardTarget = { kind: "unlinked" | "closed" } | { kind: "open"; id: string };

export type EffectDeps = {
	applied(key: string): boolean;
	markApplied(key: string): Promise<void>;
	target(threadId: string): CardTarget;
	/** A decided prose job may pass a closed card only for its saved generation. */
	proseReady?(threadId: string, questionnaireId: string, trigger: string): boolean;
	insertCard(input: {
		threadId: string;
		header: string;
		question: string;
		options: Array<{ id: string; label: string; source?: ConversationPlan.SourceRef }>;
	}): Promise<string>;
	link(threadId: string, questionnaireId: string): Promise<void>;
	addOption(questionnaireId: string, input: {
		optionId: string;
		label: string;
		trigger?: string;
		source?: ConversationPlan.SourceRef;
	}): Promise<void>;
	suggest(
		questionnaireId: string,
		input: { optionId?: string; messageIds: string[] },
	): Promise<void>;
	prompt(
		questionnaireId: string,
		generation: number,
		source?: { optionId?: string; messageId: string; sourceMessageIds?: string[] },
	): Promise<void>;
	deferPrompt?(effect: Extract<Effect, { kind: "defer-prompt" }>): Promise<void>;
	scopedChoice?(effect: Extract<Effect, { kind: "scoped-choice" }>): Promise<void>;
	/** Omitted until the narrow Planner job queue arrives in Slice 5. */
	enqueueJob?(intent: JobIntent, effectKey: string): Promise<void>;
	report(error: unknown): void;
};
