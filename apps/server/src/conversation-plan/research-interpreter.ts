import type { Chat, ConversationPlan } from "@chopin/protocol";
import { askJev, type JevQuestion, type JevRequest, type JevResult } from "./jev";
import { choice, noul } from "./policy-scoring";
import { visibleThreads } from "./question-context";
import { RESEARCH_POLICY_VERSION, researchAdmission } from "./research-admission";

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
			"Does the current speaker propose investigation or identify a meaningful unresolved information gap? Use recent conversation and decisions to resolve the topic; it need not be repeated in current.text. Tentative proposals and statements of missing current facts count, without requiring an imperative request. Ordinary chatter and unspecified topics do not. A planning decision and known alternatives are not required.",
		),
		external: probability(
			"Could published external facts help resolve the current speaker's question, proposal, or stated information gap? Unknown current pricing, published feature support, alternatives to a technology, and comparisons count. An explicit request is not required. Resolve the topic using recent discussion; unfamiliar product names are allowed. Reading this team's own code, debugging it, running experiments, and choosing personal preferences are not external research.",
		),
		owned: probability(
			"Is the assertion, request, or requirement in current.text the current speaker's own sincere, still-current contribution? Judge speaker ownership only; do not require an investigation request, a new information gap, or a clear topic. First-person plural and tentative suggestions count. Read the complete message for later withdrawal, negation, quotation, reported speech, sarcasm, or a purely hypothetical future scenario.",
		),
		research_subject: {
			type: "choice",
			instructions:
				"Where is the subject to investigate identified? Prefer explicit when the current message names the actual product(s) or a category of solutions. A factual question is explicit only if its subject is identified. An unnamed 'this library', 'that service', 'it', or similar reference needs a clear referent in recent discussion; without that, choose unclear. Unfamiliar names and missing alternatives or evaluation criteria are allowed. Use contextual for a unique subject identified only by recent discussion or decisions.",
			criteria: {
				explicit:
					"The current message identifies the actual product(s), technology category, or named subject of the factual question; no missing referent.",
				contextual:
					"Only the preceding discussion or decisions identify one clear research topic for this message.",
				unclear:
					"No research topic can be identified, or several referents are similarly plausible.",
			},
		},
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
			"Does current.text itself name what to investigate and what to learn, without needing another message to resolve pronouns? 'Investigate alternatives to [named product]' is sufficient even if the product is unfamiliar and no criteria are specified. Bare 'investigate alternatives' or 'does it support offline use' is insufficient. A withdrawn proposal is false.",
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
	if (!offers.length) delete questions.existing_offer;
	if (spans.length === 1 && spans[0]!.quote === text) delete questions.research_source;
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
		policyVersion: RESEARCH_POLICY_VERSION,
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
		let changed = noul(answers, "material_change") >= 0.8;
		let target = Object.hasOwn(request.questions, "existing_offer")
			? choice(answers, "existing_offer")
			: "new";
		let targetAnswer = answers.existing_offer;
		// Updating the sole known offer needs less certainty than creating another card.
		if (
			!target && changed && input.state.researchOffers?.length === 1
			&& targetAnswer?.type === "choice"
		) {
			let only = input.state.researchOffers[0]!;
			let probability = targetAnswer.probabilities[only.id] ?? 0;
			let competing = Math.max(
				0,
				...Object.entries(targetAnswer.probabilities).filter(([id]) => id !== only.id).map((
					[, value],
				) => value),
			);
			if (only.status === "offered" && probability >= 0.7 && probability - competing >= 0.2) {
				target = only.id;
			}
		}
		let updating = changed && !!input.state.researchOffers?.some(offer => offer.id === target);
		let { admission, failure: gate } = researchAdmission(answers, updating);
		analysis.admission = admission;
		let sourceChoice = Object.hasOwn(request.questions, "research_source")
			? choice(answers, "research_source")
			: "q0";
		let span = sourceChoice?.match(/^q(\d+)$/) && spans[Number(sourceChoice.slice(1))];
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
				changed,
				standalone: noul(answers, "standalone") >= 0.8
					|| span.quote === input.message.text
						&& choice(answers, "research_subject") === "explicit",
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
