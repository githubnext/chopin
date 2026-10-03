import * as Chat from "../chat/service";
import { isDeepStrictEqual } from "node:util";

import * as Service from "../plan/service";

import type { ConversationPlan } from "@chopin/protocol";
import type { Plan } from "../plan/service";

import type { EffectCommands } from "./service";

import { activeScopedSupport, currentScopedProposal, targetsScopedProposal } from "./events";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations/property nodes; synchronous wrappers only.
export function createScopedNotice(
	plan: Plan,
	announcer: Chat.Announcer,
): Pick<EffectCommands, "scopedChoice"> {
	return {
		scopedChoice: async effect => {
			await Service.exclusive(plan, async () => {
				let state = plan.conversationPlan;
				let thread = state.threads.find(item => item.id === effect.threadId);
				let record = plan.records.get(effect.cardId);
				if (!record) throw new Error("scoped choice card is missing");
				let trigger = state.events.find(item => item.id === effect.triggerEventId);
				let proposal = trigger?.type === "stance.changed"
					? state.events.find((item): item is Extract<ConversationPlan.Event, {
						type: "scoped-choice.proposed";
					}> => item.type === "scoped-choice.proposed" && item.id === effect.proposalId)
					: thread && currentScopedProposal(thread, state.events);
				let sources = proposal
					? [
						proposal.source,
						...(trigger?.type === "scoped-choice.agreed" || trigger?.type === "stance.changed"
							? [trigger.source]
							: []),
					]
					: [];
				if (
					!thread || !proposal || proposal.id !== effect.proposalId
					|| thread.questionnaireId !== effect.cardId
					|| ["decided", "discarded"].includes(thread.status)
					|| record.threadId !== thread.id
					|| (record.status !== "open" && record.status !== "reopened")
					|| record.history.length !== effect.generation
					|| record.definition.questions[0]?.options.filter(item =>
							item.id === effect.optionId && item.label === effect.label
						).length !== 1
					|| proposal.cardId !== effect.cardId || proposal.optionId !== effect.optionId
					|| proposal.label !== effect.label || proposal.scope !== effect.scope
					|| thread.pendingScopedChoice
						&& thread.pendingScopedChoice.proposalId !== proposal.id
					|| state.events.some(item =>
						item.type === "scoped-choice.saved" && item.proposalId === proposal.id
					)
					|| trigger?.type !== "scoped-choice.proposed"
						&& trigger?.type !== "scoped-choice.agreed"
						&& trigger?.type !== "stance.changed"
					|| trigger.type === "scoped-choice.proposed" && trigger.id !== proposal.id
					|| trigger.type === "scoped-choice.agreed" && trigger.proposalId !== proposal.id
					|| trigger.type === "stance.changed" && (
							trigger.threadId !== thread.id
							|| !targetsScopedProposal(trigger, proposal.id, proposal.optionId)
							|| trigger.source.author.kind !== "member"
						)
					|| trigger.type !== "stance.changed" && !thread.pendingScopedChoice
					|| !isDeepStrictEqual(sources, effect.sources)
				) return;
				let active = activeScopedSupport(state.events, proposal);
				let decision = {
					questionnaireId: effect.cardId,
					kind: "scoped-choice" as const,
					threadId: effect.threadId,
					proposalId: effect.proposalId,
					cardId: effect.cardId,
					optionId: effect.optionId,
					label: effect.label,
					scope: effect.scope,
					generation: effect.generation,
					triggerEventId: active.at(-1)?.id ?? proposal.id,
					sources: active.map(item => structuredClone(item.source)),
				};
				let text = `Ready to save ${effect.label} for this spike.`;
				let existing = plan.chat.entries.filter(entry =>
					entry.decision?.kind === "scoped-choice"
					&& entry.decision.threadId === effect.threadId
					&& entry.decision.questionnaireId === effect.cardId
					&& entry.decision.cardId === effect.cardId
					&& entry.decision.optionId === effect.optionId
					&& entry.decision.scope === effect.scope
					&& entry.decision.generation === effect.generation
				);
				if (!thread.pendingScopedChoice || active.length === 0) {
					if (existing.length > 1) throw new Error("scoped choice notice identity conflicts");
					if (existing[0]) {
						await Chat.refreshNoticeExclusive(announcer, existing[0].id, {
							text: `Scoped Save for ${effect.label} is no longer available.`,
							decision: { questionnaireId: effect.cardId, kind: "activity" },
						});
					}
					return;
				}
				if (existing.length > 0) {
					if (
						existing.length !== 1 || existing[0].author.kind !== "system"
						|| existing[0].text !== text
					) throw new Error("scoped choice notice identity conflicts");
					if (isDeepStrictEqual(existing[0].decision, decision)) return;
					await Chat.refreshNoticeExclusive(announcer, existing[0].id, { text, decision });
					return;
				}
				await Chat.noticeExclusive(announcer, { text, decision });
			});
		},
	};
}
