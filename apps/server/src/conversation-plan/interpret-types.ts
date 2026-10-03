import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevRequest, JevResult } from "./jev";
import type { LinkedCardOptions } from "./questions";

export type Analysis = Omit<ConversationPlan.AnalysisRecord, "messageId" | "eventIds">;
export type ResearchOfferCandidate = {
	source: ConversationPlan.ResearchSource;
	threadId: string;
	optionIds: [string, string];
	kind?: "current-cost-comparison";
} | {
	source: ConversationPlan.ResearchSource;
	threadId: string;
	optionIds: string[];
	kind: "current-cost-concern";
	focusOptionId?: string;
};
export type Interpretation = {
	events: ConversationPlan.Event[];
	analysis: Analysis;
	researchOffer?: ResearchOfferCandidate;
};
export type InterpretInput = {
	channelId: string;
	message: Chat.Entry;
	recent: readonly Chat.Entry[];
	state: ConversationPlan.State;
	linkedCards?: LinkedCardOptions;
	/** Injectable transport for domain tests; production defaults to the bounded TypeSafe adapter. */
	ask?: (request: JevRequest) => Promise<JevResult>;
};
