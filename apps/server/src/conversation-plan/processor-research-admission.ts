import type { Chat, ConversationPlan } from "@chopin/protocol";
import { createHash } from "node:crypto";
import { offerResearch } from "./domain";
import { renderResearchTask } from "./validation";
import type { Interpretation } from "./interpret";
import type { State } from "./processor-types";
import { researchQuoteFocus, researchQuoteSupportsPair } from "./processor-research-quotes";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

function researchId(kind: string, parts: readonly string[]): string {
	let hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
	return `research:${kind}:${hash}`;
}

export function admitResearchOffer(
	before: State,
	next: State,
	message: Chat.Entry,
	candidate: Interpretation["researchOffer"],
	card: { cardId: string; options: ReadonlyArray<{ id: string; label: string }> } | undefined,
	cardRecordExists: boolean,
): State {
	if (!candidate || message.author.kind !== "member") return next;
	let prior = before.threads.find(item => item.id === candidate.threadId);
	let thread = next.threads.find(item => item.id === candidate.threadId);
	if (!prior || !thread || !["exploring", "leaning", "reopened"].includes(thread.status)) {
		return next;
	}
	let isConcern = candidate.kind === "current-cost-concern";
	let kind = isConcern ? "current-cost-concern" : "current-cost-comparison";
	let currentOptions = thread.contributions.filter(item => item.kind === "option");
	let priorOptions = prior.contributions.filter(item => item.kind === "option");
	if (
		isConcern
			? ![3, 4].includes(currentOptions.length)
				|| candidate.optionIds.length !== currentOptions.length
				|| candidate.optionIds.length !== priorOptions.length
				|| !candidate.optionIds.every((id, index) => id === currentOptions[index]?.id)
				|| !candidate.optionIds.every((id, index) => id === priorOptions[index]?.id)
				|| next.threads.filter(item =>
						["exploring", "leaning", "reopened"].includes(item.status)
						&& [2, 3, 4].includes(
							item.contributions.filter(value => value.kind === "option").length,
						)
					).length !== 1
			: candidate.optionIds.length !== 2
				|| candidate.optionIds[0] === candidate.optionIds[1]
				|| currentOptions.length !== 2
	) return next;
	let options = candidate.optionIds.map(id => {
		let previous = prior.contributions.find(item => item.id === id && item.kind === "option");
		let current = thread.contributions.find(item => item.id === id && item.kind === "option");
		return previous && current
				&& (previous.displayLabel ?? previous.text) === (current.displayLabel ?? current.text)
			? current
			: undefined;
	});
	if (options.some(item => !item)) return next;
	let selectedOptions = options as ConversationPlan.Contribution[];
	if (isConcern) {
		if (cardRecordExists && !card) return next;
		if (
			card && (card.cardId !== thread.questionnaireId
				|| card.options.length !== selectedOptions.length
				|| selectedOptions.some(option =>
					!card.options.some(item =>
						item.id === option.id && item.label === (option.displayLabel ?? option.text)
					)
				))
		) return next;
		let focus = researchQuoteFocus(candidate.source.quote, selectedOptions);
		if (
			!focus || (candidate.kind === "current-cost-concern"
				&& candidate.focusOptionId !== focus.focusOptionId)
		) return next;
	} else if (!researchQuoteSupportsPair(candidate.source.quote, selectedOptions)) return next;
	let needId = researchId("need", [candidate.threadId, kind]);
	let contextId = researchId("context", [...candidate.optionIds].sort());
	if (
		(next.researchOffers ?? []).some(item =>
			item.source.messageId === message.id
			|| item.needId === needId && (
					item.status !== "dismissed" || item.contextId === contextId
				)
		)
	) return next;
	let frozen = selectedOptions.map(item => ({
		id: item.id,
		labelAtOffer: item.displayLabel ?? item.text,
	}));
	let task: ConversationPlan.ResearchTask = isConcern
		? {
			kind: "current-cost-concern",
			threadId: thread.id,
			observedEventCount: next.events.length,
			observedThreadVersion: thread.version,
			options: frozen as Extract<
				ConversationPlan.ResearchTask,
				{ kind: "current-cost-concern" }
			>["options"],
			...(candidate.kind === "current-cost-concern" && candidate.focusOptionId
				? { focusOptionId: candidate.focusOptionId }
				: {}),
		}
		: {
			kind: "current-cost-comparison",
			threadId: thread.id,
			observedEventCount: next.events.length,
			observedThreadVersion: thread.version,
			options: frozen as Extract<
				ConversationPlan.ResearchTask,
				{ kind: "current-cost-comparison" }
			>["options"],
		};
	let source = candidate.source;
	return offerResearch(next, {
		id: researchId("offer", [message.id]),
		needId,
		contextId,
		source,
		threadId: thread.id,
		task,
		brief: renderResearchTask(task, source),
	}, message);
}
