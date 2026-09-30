import type { Chat, ConversationPlan } from "@chopin/protocol";
import { isDeepStrictEqual } from "node:util";
import { ulid } from "@chopin/dialect";
import { applyEvent } from "./events";
import { validateSource } from "./sources";
import { assertCorrectionAction } from "./validation";

type State = ConversationPlan.State;
type Event = ConversationPlan.Event;
type Member = Extract<Chat.Author, { kind: "member" }>;

export function applyCorrection(
	state: State,
	request: ConversationPlan.CorrectionAction,
	actor: Member,
	at: number,
	messages?: ReadonlyMap<string, Chat.Entry> | readonly Chat.Entry[],
): State {
	assertCorrectionAction(request);
	if (actor.kind !== "member" || !actor.handle) {
		throw new Error("correction requires a human member");
	}
	let id = `human:${actor.handle}:${request.actionId}`;
	let base: ConversationPlan.EventBase = {
		id,
		threadId: request.threadId,
		observedThreadVersion: request.expectedVersion,
		origin: "human",
		actor,
		at,
	};
	let change = request.change;
	let existing = state.events.find((accepted) => accepted.id === id);
	let event: Event;
	switch (change.kind) {
		case "add-excerpt": {
			let saved = Array.isArray(messages)
				? messages.find(item => item.id === change.messageId)
				: (messages as ReadonlyMap<string, Chat.Entry> | undefined)?.get(change.messageId);
			if (!saved) throw new Error("saved excerpt message is missing");
			let quote = saved.text.slice(change.start, change.end);
			let source: ConversationPlan.SourceRef = {
				messageId: change.messageId,
				author: saved.author as ConversationPlan.SourceAuthor,
				quote,
				start: change.start,
				end: change.end,
				role: change.contributionKind,
			};
			validateSource(source, saved);
			if (!quote.trim() || quote.length > 500) throw new Error("invalid excerpt quote");
			let outcome = state.analysis.find(item => item.messageId === change.messageId)
				?.outcomes?.find(item =>
					["review", "ignored"].includes(item.status)
					&& item.start <= change.start && item.end >= change.end
				);
			if (!outcome && !existing) throw new Error("excerpt has no held analysis outcome");
			let target = state.threads.find(item => item.id === request.threadId);
			if (!target || ["decided", "discarded"].includes(target.status) && !existing) {
				throw new Error("excerpt target thread is not open");
			}
			if (target.version !== request.expectedVersion && !existing) {
				throw new Error("stale conversation thread version");
			}
			if (
				!existing && change.targetOptionId && (
					change.contributionKind === "option"
					|| !target.contributions.some(item =>
						item.kind === "option" && item.id === change.targetOptionId
					)
				)
			) throw new Error("invalid excerpt target option");
			if (
				!existing
				&& state.events.some(item =>
					item.threadId === request.threadId && "source" in item && item.source
					&& item.source.messageId === change.messageId
					&& item.source.start === change.start && item.source.end === change.end
				)
			) throw new Error("duplicate excerpt source");
			let contributionId = existing && "contribution" in existing
				? existing.contribution.id
				: ulid();
			event = {
				...base,
				type: `${change.contributionKind}.added`,
				source,
				contribution: {
					id: contributionId,
					text: quote,
					authoring: "quoted",
					targetId: change.targetOptionId ?? request.threadId,
				},
			};
			break;
		}
		case "record-decision":
			event = {
				...base,
				type: "decision.recorded",
				text: change.text,
				optionId: change.optionId,
				explicit: true,
			};
			break;
		case "confirm-candidate":
			event = { ...base, type: "candidate.confirmed", candidateId: change.candidateId };
			break;
		case "reject-candidate":
			event = { ...base, type: "candidate.rejected", candidateId: change.candidateId };
			break;
		default:
			event = { ...base, type: "card.corrected", change };
	}
	if (existing) {
		let saved = JSON.parse(JSON.stringify({ ...existing, at: 0 }));
		let submitted = JSON.parse(JSON.stringify({ ...event, at: 0 }));
		if (!isDeepStrictEqual(saved, submitted)) throw new Error("human action ID collision");
		return state;
	}
	let thread = state.threads.find((item) => item.id === request.threadId);
	if (
		change.kind === "record-decision"
		|| (change.kind === "confirm-candidate" && (
			thread?.questionnaireId
			|| thread?.candidates.some((item) =>
				item.id === change.candidateId && item.kind === "resolution"
			)
		))
		|| (thread?.questionnaireId && (
			change.kind === "set-status" || (change.kind === "edit" && change.field === "decision")
		))
	) throw new Error("decisions are recorded on the card");
	return applyEvent(state, event);
}
