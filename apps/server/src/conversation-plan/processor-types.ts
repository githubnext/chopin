import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { EffectDeps } from "./effects";
import type { Interpretation, InterpretInput } from "./interpret";
import type { ResearchInput, ResearchInterpretation } from "./research-interpreter";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export type State = ConversationPlan.State;

export type Member = Extract<Chat.Author, { kind: "member" }>;

export type Analysis = Omit<ConversationPlan.AnalysisRecord, "messageId" | "eventIds">;

export type Dependencies = {
	plan: Pick<
		Plan,
		| "id"
		| "chat"
		| "conversationPlan"
		| "conversationPlanRetries"
		| "conversationPlanEffects"
		| "conversationPlanPendingEffects"
		| "pendingCardActions"
		| "records"
	>;
	exclusive: <T>(action: () => Promise<T>) => Promise<T>;
	persist: () => Promise<void>;
	publish: (state: State) => void;
	active: () => boolean;
	interpret?: (input: InterpretInput, signal: AbortSignal) => Promise<Interpretation>;
	researchInterpret?: (
		input: ResearchInput,
		signal: AbortSignal,
	) => Promise<ResearchInterpretation>;
	effects?: EffectCommands;
	onError?: (error: unknown) => void;
	researchChanged?: () => void;
	researchPresence?: (event: ConversationPlan.ResearchPresenceChanged) => void;
};

export type EffectCommands = Omit<EffectDeps, "applied" | "markApplied">;

export type ResearchCommand =
	| { offerId: string; choice: "research" | "dismiss"; actionId: string }
	| { offerId: string; choice: "resume"; actionId?: never };

export type ResearchStart = (offer: ConversationPlan.ResearchOffer) => Promise<
	| { execution: "started"; researchRequestId: string }
	| { execution: "pending-owner" }
>;
