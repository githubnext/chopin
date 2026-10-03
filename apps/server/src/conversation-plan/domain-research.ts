import type { Chat, ConversationPlan } from "@chopin/protocol";
import { isDeepStrictEqual } from "node:util";
import { validateSource } from "./sources";
import { assertResearchOfferShape, assertStateShape, MAX_RESEARCH_OFFERS } from "./validation";
import { namesStaleResearchOption, taskMatches } from "./research-snapshots";

type State = ConversationPlan.State;

export function offerResearch(
	state: State,
	proposal: Omit<ConversationPlan.ResearchOffer, "status" | "action">,
	message: Chat.Entry,
): State {
	if (
		!proposal || typeof proposal !== "object" || Array.isArray(proposal)
		|| Object.keys(proposal).some((key) =>
			!["id", "needId", "contextId", "source", "brief", "threadId", "task"].includes(key)
		)
	) throw new Error("invalid research offer proposal");
	let offer: ConversationPlan.ResearchOffer = {
		...structuredClone(proposal),
		status: "offered",
	};
	assertResearchOfferShape(offer);
	validateSource({ ...offer.source, role: "support" }, message);
	let current = state.researchOffers ?? [];
	let existing = current.find((item) => item.id === offer.id);
	if (existing) {
		let { status: _status, action: _action, ...identity } = existing;
		if (isDeepStrictEqual(identity, proposal)) return state;
		throw new Error("research offer ID already has different content");
	}
	if (offer.threadId && !state.threads.some((thread) => thread.id === offer.threadId)) {
		throw new Error("research offer thread is missing");
	}
	if (offer.task && !taskMatches(state, offer.task)) {
		throw new Error("research task options do not match the current thread");
	}
	if (offer.task && namesStaleResearchOption(state, offer.task, offer.source.quote)) {
		throw new Error("research task source names a stale option");
	}
	if (offer.task && offer.task.observedEventCount !== state.events.length) {
		throw new Error("research task event prefix is stale");
	}
	if (current.length >= MAX_RESEARCH_OFFERS) throw new Error("research offers are full");
	let next = {
		...state,
		revision: state.revision + 1,
		researchOffers: [...current, offer],
	};
	assertStateShape(next);
	return next;
}

export function actOnResearchOffer(
	state: State,
	offerId: string,
	action: ConversationPlan.ResearchAction,
): State {
	let current = state.researchOffers ?? [];
	let index = current.findIndex((item) => item.id === offerId);
	if (index < 0) throw new Error("research offer is missing");
	let offer = current[index];
	let status: ConversationPlan.ResearchOffer["status"] = action.kind === "research"
		? "accepted"
		: "dismissed";
	assertResearchOfferShape({ ...offer, status, action });
	if (offer.status !== "offered") {
		if (
			offer.action?.id === action.id && offer.action.kind === action.kind
			&& isDeepStrictEqual(offer.action.actor, action.actor)
			&& offer.action.principalId === action.principalId
		) return state;
		throw new Error("research offer already has a terminal action");
	}
	if (current.some((item) => item.action?.id === action.id)) {
		throw new Error("research action ID already used");
	}
	let next: State = {
		...state,
		revision: state.revision + 1,
		researchOffers: current.map((item, position) =>
			position === index ? { ...item, status, action: structuredClone(action) } : item
		),
	};
	assertStateShape(next);
	return next;
}
