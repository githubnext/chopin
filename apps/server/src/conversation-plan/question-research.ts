import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevQuestion, JevRequest } from "./jev";
import type { QuoteCandidate } from "./quotes";
import { assertQuoteBudget } from "./quote-budget";
import { compactThreads, fitState, visibleThreads } from "./question-context";
import { noul } from "./question-shared";

export function buildResearchOfferRequest(
	message: Chat.Entry,
	recent: readonly Chat.Entry[],
	threads: readonly ConversationPlan.Thread[],
	candidates: readonly QuoteCandidate[],
	events: readonly ConversationPlan.Event[] = [],
): JevRequest {
	assertQuoteBudget(candidates);
	let selected = visibleThreads(threads, events).filter(({ thread, options }) =>
		["exploring", "leaning", "reopened"].includes(thread.status)
		&& [2, 3, 4].includes(thread.contributions.filter(item => item.kind === "option").length)
		&& options.length === thread.contributions.filter(item => item.kind === "option").length
	);
	if (!candidates.length || !selected.length) throw new Error("no grounded research candidates");
	let quoteCriteria: Record<string, string> = {};
	let ownershipQuestions: Record<string, JevQuestion> = {};
	for (let index = 0; index < candidates.length; index++) {
		quoteCriteria[`q${index}`] = candidates[index]!.quote.slice(0, 200);
		ownershipQuestions[`research_q${index}_owned`] = noul(
			`Is candidates[${index}].quote the current speaker's own sincere, unconditional, still-current external cost concern? Judge this exact span in all of current.text. Exclude quoted or reported words, sarcasm, hypotheticals, and a concern withdrawn later.`,
			"Direct speaker-owned concern.",
			"Quoted, conditional, reported, withdrawn, or unclear concern.",
		);
		ownershipQuestions[`research_q${index}_answered`] = noul(
			`Has the current external cost concern in candidates[${index}].quote already been answered anywhere in current.text, recent, or threads, so fresh outside research is unnecessary? A local volume estimate alone is not a current provider price answer.`,
			"The current costs have already been answered.",
			"The current costs remain unknown.",
		);
		ownershipQuestions[`research_q${index}_scope`] = {
			type: "choice",
			instructions:
				`For candidates[${index}].quote alone, which existing option does its current external cost concern uniquely name? Choose all-current only for a generic provider-price unknown naming no option. Choose none for an unclear, foreign, or multi-option concern. Do not infer a pair.`,
			criteria: {
				"all-current": "Generic current provider-price unknown without a named option.",
				...Object.fromEntries(selected.flatMap(({ options }) =>
					options.map(option => [
						option.id,
						(option.displayLabel ?? option.text).slice(0, 100),
					])
				)),
				none: "No unique current option or grounded generic concern.",
			},
		};
	}
	quoteCriteria.none = "No exact speaker-owned quote states the current external cost concern.";
	let threadCriteria: Record<string, string> = {};
	let optionCriteria: Record<string, string> = {};
	for (let { thread, options } of selected) {
		if (thread.id === "none" || thread.id === "new") continue;
		threadCriteria[thread.id] = thread.question.slice(0, 160);
		for (let option of options) {
			if (option.id === "none" || option.id === "new" || option.id in optionCriteria) continue;
			optionCriteria[option.id] = `${(option.displayLabel ?? option.text).slice(0, 100)} (in ${
				thread.question.slice(0, 100)
			})`;
		}
	}
	if (!Object.keys(threadCriteria).length || Object.keys(optionCriteria).length < 2) {
		throw new Error("no grounded research options");
	}
	threadCriteria.none = "No single active thread clearly owns this comparison.";
	optionCriteria.none = "No single existing option is clearly relevant.";
	let optionQuestion = (side: string): JevQuestion => ({
		type: "choice",
		instructions:
			`Select ${side} of exactly two distinct existing options whose current external costs need comparison. Choose none if no clear option. Do not create an option or infer a new provider.`,
		criteria: optionCriteria,
	});
	return {
		state: fitState({
			current: { id: message.id, author: message.author, text: message.text.slice(0, 4000) },
			candidates: [...candidates],
			recent: recent.filter(entry => entry.id !== message.id).slice(-12).map(entry => ({
				id: entry.id,
				text: entry.text.slice(0, 300),
			})),
			threads: compactThreads(selected, events).map((item, index) => ({
				...item,
				options: item.options.map(option => ({
					...option,
					text: (selected[index]?.options.find(value => value.id === option.id)?.displayLabel
						?? option.text).slice(0, 100),
				})),
			})),
		}),
		questions: {
			...ownershipQuestions,
			research_quote: {
				type: "choice",
				instructions:
					"Which exact candidates quote is the speaker's direct, still-current external cost concern? Choose none for quotation, report, hypothetical, ambiguity, or no suitable span.",
				criteria: quoteCriteria,
			},
			research_thread: {
				type: "choice",
				instructions:
					"Which one active planning thread owns the current external cost concern? Choose none if ambiguous or already settled.",
				criteria: threadCriteria,
			},
			research_option_a: optionQuestion("the first"),
			research_option_b: optionQuestion("the second"),
			research_kind: {
				type: "choice",
				instructions:
					"Does current.text itself raise a need for fresh outside information about current costs in one active thread? Choose comparison only for two existing options; choose concern for a generic price unknown or one-option cost concern among three or four current options. Exclude local volume estimates, general tradeoffs, and already available facts. Do not rely on answers to other questions.",
				criteria: {
					"current-cost-comparison":
						"Fresh outside pricing or cost information for both options is needed.",
					"current-cost-concern":
						"Fresh outside cost information for a three- or four-option context is needed, with at most one named focus.",
					none: "No current external cost comparison is warranted.",
				},
			},
		},
	};
}
