import type { ConversationPlan } from "@chopin/protocol";
import type { Dependencies, Member } from "./processor-types";
import { activeScopedSupport, applyEvent, currentScopedProposal } from "./events";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export function createScopedSave(
	deps: Dependencies,
	plan: Dependencies["plan"],
	active: () => boolean,
	publish: () => void,
) {
	async function saveScopedChoice(input: ConversationPlan.ScopedChoiceSave, actor: Member) {
		let changed = false;
		let result = await deps.exclusive(async () => {
			if (!active()) throw new Error("conversation analysis is unavailable");
			if (
				!input || typeof input !== "object" || Array.isArray(input)
				|| Object.keys(input).some(key =>
					![
						"actionId",
						"threadId",
						"expectedVersion",
						"proposalId",
						"cardId",
						"optionId",
						"expectedLabel",
						"expectedGeneration",
					].includes(key)
				)
				|| actor?.kind !== "member" || !actor.handle || actor.handle.length > 200
				|| typeof input.actionId !== "string"
				|| !/^[A-Za-z0-9._:-]{1,128}$/.test(input.actionId)
				|| [input.threadId, input.proposalId, input.cardId, input.optionId].some(value =>
					typeof value !== "string" || !value || value.length > 200
				)
				|| !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
				|| !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
				|| input.expectedLabel !== undefined && (
						typeof input.expectedLabel !== "string" || !input.expectedLabel.trim()
						|| input.expectedLabel.length > 200
					)
			) throw new Error("invalid scoped choice save action");
			let previous = plan.conversationPlan;
			let eventId = `human:${actor.handle}:${input.actionId}`;
			let existing = previous.events.find(event => event.id === eventId);
			if (existing) {
				if (
					existing.type !== "scoped-choice.saved"
					|| existing.actor.kind !== "member" || existing.actor.handle !== actor.handle
					|| existing.threadId !== input.threadId
					|| existing.observedThreadVersion !== input.expectedVersion
					|| existing.proposalId !== input.proposalId
					|| existing.cardId !== input.cardId || existing.optionId !== input.optionId
					|| existing.expectedLabel !== input.expectedLabel
					|| existing.expectedGeneration !== input.expectedGeneration
				) throw new Error("scoped choice action ID already used");
				return { eventId, revision: previous.revision };
			}
			let thread = previous.threads.find(item => item.id === input.threadId);
			let record = plan.records.get(input.cardId);
			let proposal = thread && currentScopedProposal(thread, previous.events);
			let options = record?.definition.questions[0]?.options ?? [];
			let option = options.filter(item => item.id === input.optionId);
			if (
				!thread || thread.version !== input.expectedVersion
				|| thread.status === "decided" || thread.status === "discarded"
				|| thread.questionnaireId !== input.cardId || !proposal
				|| proposal.id !== input.proposalId || proposal.optionId !== input.optionId
				|| !record || record.threadId !== thread.id
				|| (record.status !== "open" && record.status !== "reopened")
				|| record.history.length !== input.expectedGeneration
				|| option.length !== 1 || option[0].label !== proposal.label
				|| input.expectedLabel !== undefined && input.expectedLabel !== proposal.label
			) throw new Error("scoped choice card or proposal is stale");
			let support = activeScopedSupport(previous.events, proposal);
			if (support.length === 0) throw new Error("scoped choice has no active support");
			let legacy = support[0]?.id === proposal.id && support.length <= 2;
			let agreement = legacy && support[1]?.type === "scoped-choice.agreed"
				? support[1]
				: undefined;
			let saved: ConversationPlan.Event = {
				id: eventId,
				type: "scoped-choice.saved",
				threadId: thread.id,
				observedThreadVersion: thread.version,
				origin: "human",
				actor,
				at: Date.now(),
				proposalId: proposal.id,
				...(legacy ? {} : { supportEventIds: support.map(item => item.id) }),
				...(agreement ? { agreementId: agreement.id } : {}),
				cardId: proposal.cardId,
				optionId: proposal.optionId,
				label: proposal.label,
				scope: proposal.scope,
				sources: support.map(item => item.source),
				expectedGeneration: input.expectedGeneration,
				...(input.expectedLabel === undefined ? {} : { expectedLabel: input.expectedLabel }),
			};
			let next = applyEvent(previous, saved);
			plan.conversationPlan = next;
			try {
				await deps.persist();
			} catch (error) {
				plan.conversationPlan = previous;
				throw error;
			}
			changed = true;
			return { eventId, revision: next.revision };
		});
		if (changed) publish();
		return result;
	}
	return saveScopedChoice;
}
