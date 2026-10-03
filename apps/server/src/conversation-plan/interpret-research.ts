import type { Chat } from "@chopin/protocol";
import type { JevResult } from "./jev";
import type { InterpretInput, ResearchOfferCandidate } from "./interpret-types";
import { confidentChoice, noul } from "./interpret-scoring";
import { MAX_QUOTE_CANDIDATES } from "./quote-budget";
import type { QuoteCandidate } from "./quotes";

export type MemberResearchInput = InterpretInput & {
	message: Chat.Entry & { author: Extract<Chat.Author, { kind: "member" }> };
};

/** The main interpreter retains the original guard, request await and research catch. */
export function selectResearchOffer(
	input: MemberResearchInput,
	first: JevResult,
	quotes: QuoteCandidate[],
	result: JevResult,
): ResearchOfferCandidate | undefined {
	let researchOffer: ResearchOfferCandidate | undefined;
	if (result.model === first.model) {
		let answers = result.answers;
		let quoteKey = confidentChoice(answers, "research_quote");
		let threadId = confidentChoice(answers, "research_thread");
		let firstId = confidentChoice(answers, "research_option_a");
		let secondId = confidentChoice(answers, "research_option_b");
		let kind = confidentChoice(answers, "research_kind");
		let selectedQuote = quoteKey?.match(/^q(\d+)$/)?.[1];
		let index = selectedQuote && Number(selectedQuote) < MAX_QUOTE_CANDIDATES
			? selectedQuote
			: undefined;
		let quote = index === undefined ? undefined : quotes[Number(index)];
		let answered = answers[`research_q${index}_answered`];
		let scope = confidentChoice(answers, `research_q${index}_scope`);
		let thread = input.state.threads.find(item => item.id === threadId);
		let options = thread?.contributions.filter(item => item.kind === "option") ?? [];
		let source = quote && {
			messageId: input.message.id,
			author: input.message.author,
			quote: quote.quote,
			start: quote.start,
			end: quote.end,
		};
		let grounded = quote && thread && source
			&& ["exploring", "leaning", "reopened"].includes(thread.status)
			&& noul(first.answers, `c${index}_owned_unretracted`) >= 0.8
			&& noul(answers, `research_q${index}_owned`) >= 0.8
			&& answered?.type === "noul" && answered.noul <= 0.2
			&& /\b(?:costs?|pric(?:e|es|ing)|egress|billing|fees?|rates?)\b/i.test(quote.quote);
		if (
			grounded && source && thread
			&& firstId && secondId && firstId !== secondId
			&& options.length === 2
			&& options.some(item => item.id === firstId)
			&& options.some(item => item.id === secondId)
			&& kind === "current-cost-comparison"
		) {
			researchOffer = {
				source,
				threadId: thread.id,
				optionIds: [firstId, secondId],
			};
		} else if (
			grounded && source && thread && kind === "current-cost-concern"
			&& [3, 4].includes(options.length)
			&& input.state.threads.filter(item =>
					["exploring", "leaning", "reopened"].includes(item.status)
					&& [2, 3, 4].includes(
						item.contributions.filter(value => value.kind === "option").length,
					)
				).length === 1
			&& scope && scope !== "none"
			&& (scope === "all-current" || options.some(item => item.id === scope))
		) {
			researchOffer = {
				kind: "current-cost-concern",
				source,
				threadId: thread.id,
				optionIds: options.map(item => item.id),
				...(scope === "all-current" ? {} : { focusOptionId: scope }),
			};
		}
	}
	return researchOffer;
}
