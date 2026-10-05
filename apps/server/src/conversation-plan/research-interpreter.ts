import type { Chat, ConversationPlan } from "@chopin/protocol";
import { askJev, type JevQuestion, type JevRequest, type JevResult } from "./jev";
import { choice, noul } from "./policy-scoring";
import { visibleThreads } from "./question-context";

export const RESEARCH_QUESTION_SET = "conversation-research-1";
export type ResearchInput = {
	message: Chat.Entry;
	recent: readonly Chat.Entry[];
	state: ConversationPlan.State;
};
export type ResearchCandidate = {
	source: ConversationPlan.ResearchSource;
	context: ConversationPlan.ResearchContext;
	offerId?: string;
	explicit: boolean;
	changed: boolean;
	standalone: boolean;
};
export type ResearchInterpretation = {
	analysis: ConversationPlan.ResearchAnalysis;
	candidate?: ResearchCandidate;
};

export function researchContext(input: ResearchInput): ConversationPlan.ResearchContext {
	return {
		messages: [
			...input.recent.filter(entry =>
				entry.id !== input.message.id && !entry.streaming && entry.author.kind !== "system"
			).slice(-12),
			input.message,
		]
			.filter(entry => entry.author.kind !== "system" && entry.text.trim())
			.map(entry => ({
				id: entry.id,
				author: entry.author as ConversationPlan.SourceAuthor,
				text: entry.text.slice(0, entry.id === input.message.id ? 4000 : 300),
			})),
		decisions: visibleThreads(input.state.threads, input.state.events).map((
			{ thread, options },
		) => ({
			id: thread.id,
			version: thread.version,
			question: thread.question.slice(0, 160),
			options: options.map(item => ({
				id: item.id,
				label: (item.displayLabel ?? item.text).slice(0, 100),
			})),
			...(thread.decision ? { answer: thread.decision.text.slice(0, 160) } : {}),
		})),
	};
}

function probability(instructions: string): JevQuestion {
	return { type: "noul", instructions };
}

export function researchRequest(input: ResearchInput) {
	let context = researchContext(input);
	let text = input.message.text;
	let spans = text.length <= 2048
		? [{ start: 0, end: text.length, quote: text }]
		: [...text.matchAll(/[^\n.!?]+[.!?]?/g)]
			.filter(match => match[0].trim() && match[0].length <= 2048).slice(0, 8)
			.map(match => ({
				start: match.index!,
				end: match.index! + match[0].length,
				quote: match[0],
			}));
	let offers = (input.state.researchOffers ?? []).slice(-16).map(offer => ({
		id: offer.id,
		topic: offer.needId,
		status: offer.status,
		brief: offer.brief.slice(0, 300),
		...(offer.workflow?.previousOfferId ? { follows: offer.workflow.previousOfferId } : {}),
	}));
	let questions: Record<string, JevQuestion> = {
		research_warranted: probability(
			"Does the current speaker propose investigating a concrete topic, or raise a meaningful unresolved information gap that would benefit from external research? Tentative proposals such as 'maybe we should' count. Ordinary chatter and generic topics do not. Judge independently of whether a planning decision or alternatives already exist.",
		),
		external: probability(
			"Would published external information, documentation, alternatives, comparisons, or evidence usefully address this need? Repository-only code understanding, debugging, running experiments, and personal/team preferences are false.",
		),
		owned: probability(
			"Is the selected research source this speaker's own sincere, current proposal or information gap? Read the complete current message for later withdrawal, negation, quotation, reported speech, sarcasm, and purely hypothetical future scenarios. Tentative 'maybe we should investigate' is a genuine proposal.",
		),
		clear_subject: probability(
			"Can the research subject be clearly identified from current text, recent messages, and decisions? Resolve shorthand only when context strongly identifies one subject. If several topics are similarly plausible, answer false.",
		),
		already_answered: probability(
			"Is this information gap already answered in the supplied conversation or decisions? Merely having considered an option is not an answer. An existing offer is handled separately by existing_offer.",
		),
		explicit_proposal: probability(
			"Does the current speaker explicitly propose or request research now, including tentative requests to investigate, compare, or find alternatives? An ordinary repeated mention or acknowledgement is false.",
		),
		material_change: probability(
			"Compared with the most relevant existing research offer, does this message add a substantive requirement, scope, or distinct question not covered by its brief? Rephrasing and agreement are false. Judge the research scope, not whether an option list changed.",
		),
		standalone: probability(
			"Would the selected exact source excerpt alone be a self-contained research brief? It must identify its subject without relying on pronouns, unexplained shorthand, or other messages. It must contain only the intended research request, without a later withdrawal.",
		),
		research_source: {
			type: "choice",
			instructions:
				"Select the exact current-message excerpt supporting the research need. Choose none if no speaker-owned, unwithdrawn source supports it.",
			criteria: {
				...Object.fromEntries(spans.map((span, index) => [`q${index}`, span.quote.slice(0, 480)])),
				none: "No suitable source.",
			},
		},
		existing_offer: {
			type: "choice",
			instructions:
				"Which existing offer covers this same research topic, even if dismissed, already accepted, or the new message adds scope? Prefer the latest applicable offer. Choose new only for a distinct topic; none if unclear.",
			criteria: {
				...Object.fromEntries(offers.map(offer => [offer.id, `${offer.status}: ${offer.brief}`])),
				new: "A distinct research topic.",
				none: "No clear research subject.",
			},
		},
	};
	let state = {
		current: context.messages.find(item => item.id === input.message.id),
		recent: context.messages.filter(item => item.id !== input.message.id),
		decisions: context.decisions,
		offers,
		spans,
	};
	while (JSON.stringify(state).length > 23000 && state.recent.length) state.recent.shift();
	while (JSON.stringify(state).length > 23000 && state.decisions.length) state.decisions.pop();
	return { request: { state, questions } satisfies JevRequest, spans, context };
}

export async function interpretResearch(
	input: ResearchInput,
	ask: (request: JevRequest) => Promise<JevResult> = askJev,
): Promise<ResearchInterpretation> {
	let started = performance.now();
	let analysis: ConversationPlan.ResearchAnalysis = {
		messageId: input.message.id,
		questionSetVersion: RESEARCH_QUESTION_SET,
		modelVersion: "unavailable",
		status: "unlinked",
		answers: {},
		policyGate: "ineligible message",
		latencyMs: 0,
	};
	if (
		input.message.author.kind !== "member" || input.message.streaming || !input.message.text.trim()
		|| input.message.text.length > 4000
	) return { analysis };
	try {
		let { request, spans, context } = researchRequest(input);
		let result = await ask(request);
		analysis.modelVersion = result.model;
		analysis.answers = result.answers;
		let answers = result.answers;
		let gate = noul(answers, "research_warranted") < 0.8
			? "no clear research need"
			: noul(answers, "external") < 0.8
			? "not external research"
			: noul(answers, "owned") < 0.8
			? "source ownership unclear"
			: noul(answers, "clear_subject") < 0.8
			? "research subject unclear"
			: noul(answers, "already_answered") > 0.2
			? "research need already answered"
			: undefined;
		let sourceChoice = choice(answers, "research_source");
		let span = sourceChoice?.match(/^q(\d+)$/) && spans[Number(sourceChoice.slice(1))];
		let target = choice(answers, "existing_offer");
		if (gate || !span || !target || target === "none") {
			analysis.policyGate = gate ?? "research source or target unclear";
			return { analysis };
		}
		if (target !== "new" && !input.state.researchOffers?.some(offer => offer.id === target)) {
			throw new Error("unknown research target");
		}
		analysis.policyGate = "research opportunity identified";
		return {
			analysis,
			candidate: {
				source: { ...span, messageId: input.message.id, author: input.message.author },
				context,
				...(target === "new" ? {} : { offerId: target }),
				explicit: noul(answers, "explicit_proposal") >= 0.8,
				changed: noul(answers, "material_change") >= 0.8,
				standalone: noul(answers, "standalone") >= 0.8,
			},
		};
	} catch {
		analysis.status = "failed";
		analysis.policyGate = "research classification failed";
		return { analysis };
	} finally {
		analysis.latencyMs = Math.round(performance.now() - started);
	}
}
