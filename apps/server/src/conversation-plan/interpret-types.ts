import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevRequest, JevResult } from "./jev";
import type { LinkedCardOptions } from "./questions";

export type Analysis = Omit<ConversationPlan.AnalysisRecord, "messageId" | "eventIds">;
export type Interpretation = {
	events: ConversationPlan.Event[];
	analysis: Analysis;
};
export type InterpretInput = {
	channelId: string;
	message: Chat.Entry;
	recent: readonly Chat.Entry[];
	state: ConversationPlan.State;
	linkedCards?: LinkedCardOptions;
	/** The deployment's decisions boundary, or a scripted one in domain tests. */
	ask: (request: JevRequest) => Promise<JevResult>;
};
