import type { ConversationPlan } from "@chopin/protocol";

export type ExcerptCorrectionAction = {
	actionId: string;
	threadId: string;
	expectedVersion: number;
	change: Extract<ConversationPlan.CorrectionChange, { kind: "add-excerpt" }>;
};
