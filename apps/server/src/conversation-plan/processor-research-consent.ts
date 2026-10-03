import type { ConversationPlan } from "@chopin/protocol";
import type { Dependencies, Member, ResearchCommand, ResearchStart } from "./processor-types";
import { actOnResearchOffer } from "./domain";
import { appendEffects } from "./processor-fields";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export function createResearchConsent(
	deps: Dependencies,
	plan: Dependencies["plan"],
	active: () => boolean,
	publish: () => void,
	markApplied: (key: string) => Promise<void>,
	report: (error: unknown) => void,
) {
	async function researchConsent(
		command: ResearchCommand,
		actor: Member,
		principalId: string,
		start?: ResearchStart,
	): Promise<Omit<ConversationPlan.ResearchConsentResult, "kind" | "ts">> {
		let changed = false;
		let { offer, state, pending, applied } = await deps.exclusive(async () => {
			if (!active()) throw new Error("conversation analysis is unavailable");
			if (
				!command || typeof command.offerId !== "string" || !command.offerId
				|| command.offerId.length > 200 || !actor || actor.kind !== "member"
				|| !actor.handle || typeof principalId !== "string" || !principalId
				|| principalId.length > 200
			) throw new Error("invalid research consent action");
			let previous = plan.conversationPlan;
			let previousPending = plan.conversationPlanPendingEffects;
			let next = previous;
			if (command.choice === "resume") {
				if (command.actionId !== undefined) throw new Error("invalid research resume action");
			} else if (command.choice === "research" || command.choice === "dismiss") {
				next = actOnResearchOffer(previous, command.offerId, {
					id: command.actionId,
					kind: command.choice,
					actor,
					principalId,
					at: Date.now(),
				});
			} else throw new Error("invalid research consent choice");
			let offer = next.researchOffers?.find(item => item.id === command.offerId);
			if (!offer || command.choice === "resume" && offer.status !== "accepted") {
				throw new Error("research offer is not accepted");
			}
			let key = `research:${offer.id}`;
			if (next !== previous) {
				plan.conversationPlan = next;
				try {
					if (offer.status === "accepted") {
						plan.conversationPlanPendingEffects = appendEffects(plan, [{
							key,
							kind: "research",
							offerId: offer.id,
						}]);
					}
					await deps.persist();
					changed = true;
				} catch (error) {
					plan.conversationPlan = previous;
					plan.conversationPlanPendingEffects = previousPending;
					throw error;
				}
			}
			let pending = plan.conversationPlanPendingEffects.some(item => item.key === key);
			let applied = plan.conversationPlanEffects.includes(key);
			if (offer.status === "accepted" && !pending && !applied) {
				throw new Error("accepted research offer has no delivery record");
			}
			return { offer: structuredClone(offer), state: next, pending, applied };
		});
		if (changed) publish();
		let base = { offerId: offer.id, status: offer.status, revision: state.revision };
		if (offer.status === "dismissed") return { ...base, execution: "none" };
		if (applied) return { ...base, execution: "started" };
		if (!pending || !start) return { ...base, execution: "pending-retry" };
		try {
			let outcome = await start(offer);
			if (outcome.execution === "pending-owner") return { ...base, execution: "pending-owner" };
			await markApplied(`research:${offer.id}`);
			return { ...base, ...outcome };
		} catch (error) {
			report(error);
			return { ...base, execution: "pending-retry" };
		}
	}
	return researchConsent;
}
