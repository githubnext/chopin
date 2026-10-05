import { createHash } from "node:crypto";
import type { ConversationPlan } from "@chopin/protocol";
import { offerResearch } from "./domain-research";
import type { ResearchInput, ResearchInterpretation } from "./research-interpreter";
import { validateSource } from "./sources";

export function researchIdentity(kind: string, ...parts: string[]): string {
	return `research:${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export function researchTargetChanged(
	state: ConversationPlan.State,
	input: ResearchInput,
	result: ResearchInterpretation,
): boolean {
	let target = result.candidate?.offerId;
	if (target) {
		let before = input.state.researchOffers?.find(item => item.id === target);
		let current = state.researchOffers?.find(item => item.id === target);
		if (JSON.stringify(before) !== JSON.stringify(current)) return true;
	}
	return !!result.candidate?.context.decisions.some(before =>
		state.threads.find(item => item.id === before.id)?.version !== before.version
	);
}

/** Returns a new state; the caller commits it together with its analysis receipt. */
export function applyResearchOpportunity(
	state: ConversationPlan.State,
	channelId: string,
	input: ResearchInput,
	result: ResearchInterpretation,
): ConversationPlan.State {
	let candidate = result.candidate;
	if (!candidate) return state;
	validateSource({ ...candidate.source, role: "support" }, input.message);
	let current = state.researchOffers ?? [];
	let previous = current.find(item => item.id === candidate.offerId);
	let gate = (reason: string, offerId?: string) => {
		result.analysis.policyGate = reason;
		if (offerId) result.analysis.offerId = offerId;
		return state;
	};
	if (candidate.offerId && !previous) return gate("research target no longer exists");
	if (
		current.some(item =>
			item.source.messageId === input.message.id
			|| item.workflow?.sources.some(source => source.messageId === input.message.id)
		)
	) return gate("research message already applied");
	if (previous?.status === "dismissed" && !candidate.explicit && !candidate.changed) {
		return gate("dismissed research topic", previous.id);
	}
	if (previous?.status === "accepted" && !candidate.changed) {
		return gate("research already covers this scope", previous.id);
	}
	if (previous?.status === "offered" && !candidate.changed) {
		return gate("research already suggested", previous.id);
	}
	if (previous?.status === "offered" && previous.workflow) {
		let offer = structuredClone(previous);
		let workflow = offer.workflow!;
		if (workflow.sources.length >= 24 || workflow.additions.length >= 32) {
			return gate("research context capacity reached", offer.id);
		}
		workflow.sources.push(candidate.source);
		workflow.placementMessageId = input.message.id;
		workflow.context = candidate.context;
		workflow.generation++;
		workflow.revision++;
		workflow.preparation = "pending";
		delete workflow.jobId;
		if (workflow.mode === "human") {
			workflow.additions.push({
				id: researchIdentity("addition", offer.id, input.message.id),
				text: candidate.source.quote,
				sources: [candidate.source],
				status: "pending",
			});
			result.analysis.policyGate = "research addition proposed";
		} else result.analysis.policyGate = "research brief refresh requested";
		result.analysis.status = "applied";
		result.analysis.offerId = offer.id;
		return { ...state, researchOffers: current.map(item => item.id === offer.id ? offer : item) };
	}
	let id = researchIdentity("offer", channelId, input.message.id);
	let offer: Omit<ConversationPlan.ResearchOffer, "status" | "action"> = {
		id,
		needId: previous?.needId ?? researchIdentity("topic", channelId, input.message.id),
		contextId: id,
		source: candidate.source,
		brief: candidate.source.quote,
		workflow: {
			version: 1,
			revision: 0,
			generation: 0,
			mode: "automatic",
			placementMessageId: input.message.id,
			sources: [candidate.source],
			context: candidate.context,
			published: candidate.standalone,
			preparation: "pending",
			editedBy: [],
			additions: [],
			...(previous ? { previousOfferId: previous.id } : {}),
		},
	};
	let next = offerResearch(state, offer, input.message);
	result.analysis.status = "applied";
	result.analysis.offerId = id;
	result.analysis.policyGate = previous?.status === "accepted"
		? "follow-up research offered"
		: candidate.standalone
		? "research offered"
		: "research brief preparing";
	return next;
}
