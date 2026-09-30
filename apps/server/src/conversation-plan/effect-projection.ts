import type { ConversationPlan } from "@chopin/protocol";
import { ULID } from "@chopin/dialect";
import * as Question from "@chopin/question";
import { currentScopedProposal, targetsScopedProposal } from "./events";
import { QUESTION_SET_VERSION } from "./question-shared";
import { effectivePreference } from "./preference";
import { scopedKey } from "./effect-fields";
import type { Effect } from "./effect-types";
// Extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.ts.

function purposeful(analysis?: ConversationPlan.AnalysisRecord): boolean {
	if (
		analysis?.questionSetVersion !== QUESTION_SET_VERSION
		&& analysis?.questionSetVersion !== "conversation-plan-4"
	) return false;
	let triage = analysis.passes.find(pass => pass.stage === "triage");
	let answer = triage?.answers.enough_purpose;
	return answer?.type === "noul" && answer.noul >= 0.75;
}

export function effectsFor(
	events: readonly ConversationPlan.Event[],
	state: ConversationPlan.State,
	analysis?: ConversationPlan.AnalysisRecord,
	records?: ReadonlyMap<string, {
		history: readonly unknown[];
		definition?: { questions: readonly { options: readonly { id: string }[] }[] };
	}>,
): Effect[] {
	let effects: Effect[] = [];
	let opened = new Set(
		events.filter(event => event.type === "thread.opened").map(event => event.threadId),
	);
	for (let event of events) {
		let thread = state.threads.find(item => item.id === event.threadId);
		if (!thread) continue;
		if (event.type === "settle.deferred") {
			effects.push({
				key: `defer-prompt:${event.id}`,
				kind: "defer-prompt",
				threadId: thread.id,
				proposalId: event.proposalId,
				deferredEventId: event.id,
			});
		}
		if (
			event.type === "stance.changed" && event.position !== "support"
			&& event.source.author.kind === "member"
		) {
			let participant = event.source.author.handle;
			let eventIndex = state.events.findIndex(item => item.id === event.id);
			let earlier = eventIndex < 0 ? [] : state.events.slice(0, eventIndex);
			let proposal = earlier.findLast((item): item is Extract<
				ConversationPlan.Event,
				{ type: "scoped-choice.proposed" }
			> =>
				item.type === "scoped-choice.proposed" && item.threadId === thread.id
				&& (typeof event.scopedProposalId !== "string"
					|| item.id === event.scopedProposalId)
			);
			if (
				!proposal || proposal.source.author.kind !== "member"
				|| !targetsScopedProposal(event, proposal.id, proposal.optionId)
				|| thread.questionnaireId !== proposal.cardId
				|| thread.pendingScopedChoice
					&& thread.pendingScopedChoice.proposalId !== proposal.id
				|| earlier.some(item =>
					item.type === "scoped-choice.saved" && item.proposalId === proposal.id
				)
				|| participant !== proposal.source.author.handle
					&& !earlier.some(item =>
						item.type === "scoped-choice.agreed" && item.proposalId === proposal.id
						&& item.source.author.kind === "member"
						&& item.source.author.handle === participant
					)
			) continue;
			let record = records?.get(proposal.cardId);
			if (records && !record) throw new Error("linked scoped choice card is missing");
			effects.push({
				key: scopedKey(proposal.id, event.id),
				kind: "scoped-choice",
				threadId: thread.id,
				proposalId: proposal.id,
				cardId: proposal.cardId,
				optionId: proposal.optionId,
				label: proposal.label,
				scope: proposal.scope,
				generation: record?.history.length ?? 0,
				triggerEventId: event.id,
				sources: [proposal.source, event.source],
			});
			continue;
		}
		if (event.type === "scoped-choice.proposed" || event.type === "scoped-choice.agreed") {
			let proposal = currentScopedProposal(thread, state.events);
			if (
				!proposal || !thread.questionnaireId || thread.questionnaireId !== proposal.cardId
				|| ["decided", "discarded"].includes(thread.status)
				|| state.events.some(item =>
					item.type === "scoped-choice.saved" && item.proposalId === proposal.id
				)
				|| event.type === "scoped-choice.proposed" && event.id !== proposal.id
				|| event.type === "scoped-choice.agreed" && event.proposalId !== proposal.id
				|| event.type === "scoped-choice.agreed" && (
						event.cardId !== proposal.cardId || event.optionId !== proposal.optionId
						|| event.label !== proposal.label || event.scope !== proposal.scope
					)
			) continue;
			let record = records?.get(proposal.cardId);
			if (records && !record) throw new Error("linked scoped choice card is missing");
			effects.push({
				key: scopedKey(proposal.id, event.id),
				kind: "scoped-choice",
				threadId: thread.id,
				proposalId: proposal.id,
				cardId: proposal.cardId,
				optionId: proposal.optionId,
				label: proposal.label,
				scope: proposal.scope,
				generation: record?.history.length ?? 0,
				triggerEventId: event.id,
				sources: [
					proposal.source,
					...(event.type === "scoped-choice.agreed"
						? [event.source]
						: []),
				],
			});
			continue;
		}
		if (event.type === "thread.opened") {
			if (thread.questionnaireId || ["decided", "discarded"].includes(thread.status)) continue;
			effects.push({
				key: `insert:${thread.id}`,
				kind: "insert-card",
				threadId: thread.id,
				header: thread.question.trim().slice(0, Question.limits.MAX_HEADER),
				question: thread.question,
				options: thread.contributions.filter(item => item.kind === "option" && ULID.test(item.id))
					.slice(0, Question.limits.MAX_DECISION_OPTIONS)
					.map(item => {
						let source = item.sources.find(source => source.role === "option");
						return {
							id: item.id,
							label: item.text.trim().slice(0, Question.limits.MAX_LABEL),
							...(source ? { source } : {}),
						};
					}),
				trigger: event.id,
			});
		} else if (
			event.type === "option.added"
			&& (event.origin === "classifier" || !!event.source)
		) {
			if (opened.has(thread.id) || !ULID.test(event.contribution.id)) continue;
			let card = thread.questionnaireId ? records?.get(thread.questionnaireId) : undefined;
			if (card?.definition?.questions[0]?.options.some(item => item.id === event.contribution.id)) {
				continue;
			}
			effects.push({
				key: `option:${event.contribution.id}`,
				kind: "add-option",
				threadId: thread.id,
				optionId: event.contribution.id,
				label: event.contribution.text.trim().slice(0, Question.limits.MAX_LABEL),
				trigger: event.id,
				...(event.source?.role === "option" ? { source: event.source } : {}),
			});
			if (thread.questionnaireId && event.origin !== "human") {
				if (!event.source) continue;
				effects.push({
					key: `job:suggest:${thread.questionnaireId}:${event.id}`,
					kind: "job",
					threadId: thread.id,
					intent: {
						kind: "suggest",
						target: thread.questionnaireId,
						trigger: event.source.messageId,
					},
				});
			}
		} else if (event.type === "card.linked") {
			let source = thread.questionSources[0];
			if (!source) continue;
			effects.push({
				key: `job:refine:${event.questionnaireId}`,
				kind: "job",
				threadId: thread.id,
				intent: { kind: "refine", target: event.questionnaireId, trigger: source.messageId },
			});
		} else if (event.type === "thread.leaning") {
			if (!event.optionId || !ULID.test(event.optionId)) continue;
			effects.push({
				key: `suggest:${event.id}`,
				kind: "suggest",
				threadId: thread.id,
				optionId: event.optionId,
				messageIds: "source" in event && event.source ? [event.source.messageId] : [],
			});
		}
	}
	let reconciliations = new Map<string, Extract<ConversationPlan.Event, { source: unknown }>>();
	for (let event of events) {
		if (
			event.type === "settle.suggested" || event.type === "settle.agreed"
			|| event.type === "settle.resumed"
		) {
			reconciliations.set(event.threadId, event);
		} else if (event.type === "stance.changed" && event.optionId) {
			let thread = state.threads.find(item => item.id === event.threadId);
			let actor = event.source.author;
			let eventIndex = state.events.findIndex(item => item.id === event.id);
			if (thread?.pendingSettle?.optionId !== event.optionId || actor.kind !== "member") continue;
			if (
				state.events.slice(0, eventIndex < 0 ? undefined : eventIndex).some(item =>
					item.threadId === event.threadId
					&& (item.type === "settle.suggested" || item.type === "settle.agreed")
					&& item.optionId === event.optionId
					&& item.source.author.kind === "member"
					&& item.source.author.handle === actor.handle
				)
			) reconciliations.set(event.threadId, event);
		}
	}
	for (let [threadId, trigger] of reconciliations) {
		let thread = state.threads.find(item => item.id === threadId);
		if (
			!thread?.pendingSettle || !ULID.test(thread.pendingSettle.optionId)
			|| ["decided", "discarded"].includes(thread.status)
		) continue;
		let preference = effectivePreference(thread, state.events);
		let optionId = preference?.optionId;
		let messageIds = preference?.messageIds ?? [];
		let record = thread.questionnaireId && records?.get(thread.questionnaireId);
		if (thread.questionnaireId && !record) throw new Error("linked prompt card is missing");
		effects.push({
			key: `suggest:${trigger.id}`,
			kind: "suggest",
			threadId,
			...(optionId ? { optionId } : {}),
			messageIds,
		});
		effects.push({
			key: `prompt:${trigger.id}`,
			kind: "prompt",
			threadId,
			...(optionId ? { optionId } : {}),
			messageId: trigger.source.messageId,
			generation: record ? record.history.length : 0,
			sourceMessageIds: messageIds,
		});
	}
	if (purposeful(analysis)) {
		effects.push({
			key: "job:heading:document",
			kind: "job",
			intent: { kind: "heading", target: "document", trigger: analysis!.messageId },
		});
	}
	return effects;
}
