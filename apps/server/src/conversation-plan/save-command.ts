import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { AuthorizationResult } from "../wire";
import type { Processor } from "./service";

type Member = Extract<Chat.Author, { kind: "member" }>;
type Current<T> = T | (() => T);

export type ScopedChoiceSaveRoute = {
	refreshAccess: () => Promise<AuthorizationResult>;
	conversationPlanEnabled: Current<boolean>;
	canEdit: Current<boolean>;
	archived: Current<boolean>;
	roomClosing: Current<boolean>;
	actor: Current<Member>;
	processor?: Current<Pick<Processor, "saveScopedChoice"> | undefined>;
	reply: (rid: string, frame: ConversationPlan.SavedScopedChoice) => void;
	fail: (rid: string, message: string) => void;
};

function current<T>(value: Current<T>): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

/** Receive only the authenticated socket's member identity and bounded command fields. */
export async function handleScopedChoiceSave(
	frame: ConversationPlan.SaveScopedChoice & { rid: string },
	deps: ScopedChoiceSaveRoute,
): Promise<void> {
	try {
		let access = await deps.refreshAccess();
		if (access === "unavailable") throw new Error("authorization is temporarily unavailable");
		if (access !== "allowed") throw new Error("authorization expired");
		if (!current(deps.conversationPlanEnabled)) {
			throw new Error("conversation analysis is disabled");
		}
		if (!current(deps.canEdit) || current(deps.archived) || current(deps.roomClosing)) {
			throw new Error("repository write access is required");
		}
		let processor = deps.processor && current(deps.processor);
		if (!processor) throw new Error("document is not open");
		let actor = current(deps.actor);
		let result = await processor.saveScopedChoice({
			actionId: frame.actionId,
			threadId: frame.threadId,
			expectedVersion: frame.expectedVersion,
			proposalId: frame.proposalId,
			cardId: frame.cardId,
			optionId: frame.optionId,
			...(frame.expectedLabel === undefined ? {} : { expectedLabel: frame.expectedLabel }),
			expectedGeneration: frame.expectedGeneration,
		}, { kind: "member", handle: actor.handle });
		deps.reply(frame.rid, { kind: "conversation-plan:scoped-choice-save", ts: 0, ...result });
	} catch (error) {
		deps.fail(
			frame.rid,
			error instanceof Error ? error.message : "cannot save scoped choice",
		);
	}
}
