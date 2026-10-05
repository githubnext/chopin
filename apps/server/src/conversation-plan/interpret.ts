import type { ConversationPlan } from "@chopin/protocol";
import { askJev, type JevAnswer } from "./jev";
import { planEvents } from "./policy";
import {
	buildCandidateTargetingRequest,
	buildTriageRequest,
	QUESTION_SET_VERSION,
} from "./questions";
import { extractQuotes } from "./quotes";
import { assertQuoteBudget } from "./quote-budget";
import { noul, score } from "./interpret-scoring";
import type { Analysis, Interpretation, InterpretInput } from "./interpret-types";
export type { Interpretation, InterpretInput, ResearchOfferCandidate } from "./interpret-types";

/** Computes a proposal only; the caller owns fenced persistence and publication. */
export async function interpretMessage(input: InterpretInput): Promise<Interpretation> {
	let started = performance.now();
	let passes: ConversationPlan.AnalysisPass[] = [];
	let modelVersion = "unavailable";
	let base: Omit<Analysis, "status"> = {
		questionSetVersion: QUESTION_SET_VERSION,
		modelVersion,
		passes,
	};
	if (
		input.message.streaming || input.message.author.kind === "system" || !input.message.text.trim()
	) {
		return {
			events: [],
			analysis: { ...base, status: "unlinked", policyGate: "ineligible message" },
		};
	}
	if (input.message.text.length > 4000) {
		return {
			events: [],
			analysis: { ...base, status: "unlinked", policyGate: "message exceeds ownership context" },
		};
	}
	let ask = input.ask ?? askJev;
	try {
		let quotes = extractQuotes(input.message.text);
		assertQuoteBudget(quotes);
		let first = await ask(buildTriageRequest(
			input.message,
			input.recent,
			input.state.threads,
			quotes,
			input.state.events,
		));
		modelVersion = first.model;
		passes.push({ stage: "triage", answers: first.answers });
		let triageTarget = first.answers.thread_target;
		let rankedTargets = triageTarget?.type === "choice"
			? Object.values(triageTarget.probabilities).sort((a, b) => b - a)
			: [];
		let cardTarget = triageTarget?.type === "choice"
				&& (rankedTargets[0] ?? 0) >= 0.8
				&& (rankedTargets[0] ?? 0) - (rankedTargets[1] ?? 0) >= 0.2
			? triageTarget.choice
			: undefined;
		let linkedCards = new Map(
			cardTarget && input.linkedCards?.has(cardTarget)
				? [[cardTarget, input.linkedCards.get(cardTarget)!]]
				: [],
		);
		let useful = [
			"new_question",
			"new_option",
			"reason",
			"constraint",
			"evidence",
			"assumption",
			"support",
			"objection",
			"correction",
			"withdrawal",
			"explicit_resolution",
			"reopening",
		].some((key) => noul(first.answers, key) >= 0.55)
			|| score(first.answers, "significance") >= 1.5;
		if (!useful) {
			return {
				events: [],
				analysis: {
					...base,
					modelVersion,
					status: "unlinked",
					policyGate: "low planning significance",
					latencyMs: Math.round(performance.now() - started),
				},
			};
		}
		if (!quotes.length) {
			return {
				events: [],
				analysis: {
					...base,
					modelVersion,
					status: "unlinked",
					policyGate: "no bounded source quote",
					latencyMs: Math.round(performance.now() - started),
				},
			};
		}
		let requests = quotes.map((_, index) =>
			buildCandidateTargetingRequest(
				input.message,
				input.recent,
				input.state.threads,
				quotes,
				index,
				input.state.events,
				linkedCards,
			)
		);
		let settled = await Promise.allSettled(requests.map(request => ask(request)));
		let targeted = settled.map(result => {
			if (result.status === "rejected") throw result.reason;
			return result.value;
		});
		if (targeted.some(result => result.model !== first.model)) {
			throw new Error("inconsistent Jev model versions");
		}
		let answers = Object.assign({}, ...targeted.map(result => result.answers)) as Record<
			string,
			JevAnswer
		>;
		if (Object.keys(answers).length > 45) throw new Error("too many targeting answers");
		passes.push({ stage: "targeting", answers: structuredClone(answers) });
		let policyAnswers = { ...answers };
		for (let [index, request] of requests.entries()) {
			let key = `c${index}_duplicate`;
			if (!(key in request.questions)) policyAnswers[key] = { type: "noul", noul: 0 };
		}
		let candidates = quotes.map((quote, index) => ({
			...quote,
			answers: Object.fromEntries(
				Object.entries(policyAnswers)
					.filter(([key]) => key.startsWith(`c${index}_`))
					.map(([key, answer]) => [key.slice(3), answer]),
			),
		}));
		let planned = planEvents({
			channelId: input.channelId,
			message: input.message,
			state: input.state,
			linkedCards,
			first: first.answers,
			candidates,
		});
		return {
			events: planned.events,
			analysis: {
				...base,
				modelVersion: first.model,
				status: planned.events.length ? "applied" : "unlinked",
				selectedTarget: planned.selectedTarget,
				quoteValidation: quotes.map((quote) => ({
					start: quote.start,
					end: quote.end,
					valid: input.message.text.slice(quote.start, quote.end) === quote.quote,
				})),
				policyGate: planned.policyGate,
				outcomes: planned.outcomes,
				candidates: planned.candidates,
				latencyMs: Math.round(performance.now() - started),
			},
		};
	} catch {
		return {
			events: [],
			analysis: {
				...base,
				modelVersion,
				status: "failed",
				error: "Jev interpretation failed",
				latencyMs: Math.round(performance.now() - started),
			},
		};
	}
}
