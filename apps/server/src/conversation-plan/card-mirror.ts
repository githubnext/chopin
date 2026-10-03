import type { ConversationPlan } from "@chopin/protocol";
import type { PendingCardAction } from "../questions/card-actions";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, cards.ts pure event derivation.
export function mirroredEvent(
	thread: ConversationPlan.Thread,
	action: PendingCardAction,
): ConversationPlan.Event | undefined {
	let base = {
		id: action.id,
		threadId: action.threadId,
		observedThreadVersion: thread.version,
		at: action.at,
	};
	switch (action.kind) {
		case "decided": {
			let chosen = action.optionIds.find(id =>
				thread.contributions.some(item => item.kind === "option" && item.id === id)
			);
			return {
				...base,
				type: "decision.recorded",
				origin: "human",
				actor: { kind: "member", handle: action.actor },
				text: action.text,
				...(chosen ? { optionId: chosen } : {}),
				explicit: true,
			};
		}
		case "reopened":
			return {
				...base,
				type: "decision.reopened",
				origin: "human",
				actor: { kind: "member", handle: action.actor },
				explicit: true,
			};
		case "discarded":
			return {
				...base,
				type: "thread.discarded",
				origin: "human",
				actor: { kind: "member", handle: action.actor },
			};
		case "option-added":
			if (thread.contributions.some(item => item.id === action.optionId)) return;
			return {
				...base,
				type: "option.added",
				origin: action.origin,
				actor: action.origin === "planner"
					? { kind: "agent" }
					: { kind: "member", handle: action.actor },
				contribution: {
					id: action.optionId,
					text: action.label,
					authoring: action.origin === "planner" ? "scribe" : "human-edited",
					targetId: thread.id,
				},
			};
	}
}
