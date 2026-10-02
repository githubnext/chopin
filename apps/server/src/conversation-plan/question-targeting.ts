import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevQuestion, JevRequest } from "./jev";
import { isBareEditorOptionList, isExplicitCompoundDecision, type QuoteCandidate } from "./quotes";
import { assertQuoteBudget, MAX_QUOTE_CANDIDATES } from "./quote-budget";
import { effectivePending } from "./preference";
import {
	cardChoices,
	compactThreads,
	fitState,
	threadChoices,
	visibleThreads,
} from "./question-context";
import { FOUR_CANDIDATE_QUESTIONS, hasWithdrawalCue, noul } from "./question-shared";
import type { LinkedCardOptions } from "./question-shared";

export function buildTargetingRequest(
	message: Chat.Entry,
	recent: readonly Chat.Entry[],
	threads: readonly ConversationPlan.Thread[],
	candidates: readonly QuoteCandidate[],
	focusIndex?: number,
	events: readonly ConversationPlan.Event[] = [],
	linkedCards: LinkedCardOptions = new Map(),
): JevRequest {
	assertQuoteBudget(candidates);
	let bareEditor = isBareEditorOptionList(message.text, candidates);
	let focus = focusIndex === undefined ? undefined : candidates[focusIndex];
	let compoundDecision = !!focus && isExplicitCompoundDecision(message.text, candidates);
	if (
		focusIndex !== undefined && (!focus || focusIndex < 0 || focusIndex >= MAX_QUOTE_CANDIDATES
			|| message.text.slice(focus.start, focus.end) !== focus.quote)
	) {
		throw new Error("invalid targeting candidate");
	}
	let questions: Record<string, JevQuestion> = {};
	let selected = visibleThreads(threads, events);
	// The service supplies recent as the chat prefix before this message. Source-free
	// contributions cannot be ordered safely when an older message is retried.
	let earlierMessageIds = new Set(
		recent.filter(entry =>
			entry.id !== message.id && entry.ts <= message.ts
			&& entry.author.kind !== "system" && !entry.streaming
		).map(entry => entry.id),
	);
	let priorContributions = selected.flatMap(({ thread }) =>
		thread.contributions.filter(contribution =>
			contribution.text.trim() && contribution.sources.length > 0
			&& contribution.sources.every(source =>
				source.messageId !== message.id && earlierMessageIds.has(source.messageId)
			)
		).map(contribution => ({
			id: contribution.id,
			text: contribution.text.slice(0, 300),
		}))
	).slice(-8);
	let threadCriteria = threadChoices(selected);
	let pending = selected.flatMap(({ thread }) => {
		let proposal = effectivePending(thread, events);
		return proposal ? [{ thread, proposal }] : [];
	});
	for (let { thread, proposal } of pending) {
		let option = thread.contributions.find(item => item.id === proposal.optionId);
		if (!option) continue;
		threadCriteria[thread.id] += ` Pending proposal to settle on "${
			option.text.slice(0, 100)
		}" by ${proposal.proposer.slice(0, 80)}.`;
	}
	let solePending = pending.length === 1 ? pending[0] : undefined;
	let soleOption = solePending?.thread.contributions.find(item =>
		item.id === solePending.proposal.optionId
	);
	let optionCriteria: Record<string, string> = {};
	for (let { thread, options } of selected) {
		for (let option of options) {
			if (["new", "none"].includes(option.id)) throw new Error("reserved conversation option ID");
			optionCriteria[option.id] = `${option.text.slice(0, 100)} (in ${
				thread.question.slice(0, 100)
			})`;
		}
	}
	Object.assign(optionCriteria, cardChoices(selected, linkedCards));
	optionCriteria.new = "A distinct option that does not yet exist.";
	optionCriteria.none = "No specific option can be identified.";
	for (let index = 0; index < candidates.length; index++) {
		let path = `candidates[${index}].quote`;
		let prefix = `c${index}_`;
		questions[`${prefix}role`] = {
			type: "choice",
			instructions:
				`What single planning role does ${path} play as this speaker's own assertion? Do not mistake a quotation, reported agreement, sarcasm, or assent for a proposal to settle.`
				+ (compoundDecision
					? " Use current.fullMessage only to assess the speaker's intent and ownership; classify this exact span."
					: ""),
			criteria: {
				question: "New unresolved planning question.",
				option: "Distinct proposed course of action.",
				reason: "Reason or evidence for a plan.",
				constraint: "Requirement or limitation.",
				support: "Speaker's support for an existing option.",
				objection: "Speaker's objection to an option or decision.",
				resolution: "Speaker proposes settling on one definite option now.",
				reopening: "Speaker explicitly requests reopening a decision.",
				none: "No useful atomic planning contribution, or unclear/quoted/sarcastic content.",
			},
		};
		questions[`${prefix}thread`] = {
			type: "choice",
			instructions:
				`Which planning thread does ${path} address? Judge this exact quote; later clauses of current.text may address a different thread. A short assent or direct withdrawal may target a pending proposal to settle if the quote and preceding context clearly refer to it. Use new for a distinct question; none if unclear.`,
			criteria: threadCriteria,
		};
		questions[`${prefix}option`] = {
			type: "choice",
			instructions:
				`Which existing option does ${path} discuss, support, oppose, or withdraw a proposal for? A direct withdrawal may target the specific pending option through preceding context. A resolution may address a rejected option; this question does not identify the chosen option. Use new for a distinct option or none if unclear.`,
			criteria: optionCriteria,
		};
		questions[`${prefix}chosen_option`] = {
			type: "choice",
			instructions:
				`If ${path} proposes settling a team choice, which option does the speaker positively choose? Do not select an option the speaker rejects, negates, or merely mentions. Select new only for a clearly proposed plan absent from the listed options; select none for no clear chosen option.`,
			criteria: {
				...Object.fromEntries(
					Object.entries(optionCriteria).filter(([key]) => key !== "new" && key !== "none"),
				),
				new: "A clearly adopted plan not represented by an existing option.",
				none: "No explicit chosen option; only a rejected/quoted option or unclear resolution.",
			},
		};
		questions[`${prefix}relation`] = {
			type: "choice",
			instructions: `How does ${path} relate to its target?`,
			criteria: {
				supports: "Supports it.",
				challenges: "Challenges it.",
				qualifies: "Adds a condition.",
				replaces: "Explicitly supersedes it.",
				unrelated: "No clear relation.",
			},
		};
		questions[`${prefix}new_option`] = noul(
			`Does ${path} itself propose a distinct plan option? Judge this exact quote only, not other clauses in current.text.`,
			"A concrete distinct course of action in this quote.",
			"No new option in this quote, or merely chatter/assent.",
		);
		questions[`${prefix}planning_substance`] = noul(
			`Does ${path} itself contain a substantive planning reason, requirement, or concern? Judge only this quote; vague deictic chatter without a clear plan point is false.`,
			"A specific reason, requirement, or concern in this quote.",
			"No specific planning substance in this quote.",
		);
		questions[`${prefix}support`] = noul(
			`Does the current speaker personally support an option in ${path}? A quote, reported stance, or sarcasm is false.`,
			"This quote expresses the speaker's own support.",
			"No personal support in this quote.",
		);
		questions[`${prefix}objection`] = noul(
			`Does the current speaker personally object to a plan in ${path}? A quote, report, or sarcasm is false.`,
			"This quote expresses the speaker's own plan objection.",
			"No personal plan objection in this quote.",
		);
		if (priorContributions.length) {
			questions[`${prefix}duplicate`] = noul(
				`Compare only ${path} with state.priorContributions. Is this exact focused quote merely a duplicate of one of those earlier contributions, with no new substantive detail? Do not compare other spans of the current message or preceding context.`,
				"Duplicate of a named prior contribution.",
				"New detail or distinct contribution.",
			);
		}
		questions[`${prefix}explicit_resolution`] = noul(
			`Does ${path} itself propose that the team settle on one definite option now, such as 'let's just go with X' or 'we decided X'? Judge only this speaker's own assertion. A question, reported or quoted decision, hedged preference, or sarcasm is false.`,
			"Proposal to settle now.",
			"No proposal to settle.",
		);
		if (pending.length) {
			let referent = solePending && soleOption
				? `the pending proposal by ${solePending.proposal.proposer.slice(0, 80)} to settle on "${
					soleOption.text.slice(0, 100)
				}" in the "${solePending.thread.question.slice(0, 160)}" thread`
				: "a clearly identified pending proposal in threads[].pendingSettle";
			questions[`${prefix}agrees_with_settle`] = noul(
				`Does ${path} itself agree with ${referent}? Judge this exact quote and preceding context, not later clauses of current.text. Plain assent counts when it clearly follows that proposal; quoted or reported assent, sarcasm, and agreement with a different target do not. If several proposals are pending, require a clear referent.`,
				"The speaker agrees with the pending proposal to settle.",
				"No agreement with a pending proposal.",
			);
			if (focusIndex !== undefined) {
				questions[`${prefix}qualifies_pending_settle`] = noul(
					`Does ${path} itself state a specific requirement or condition on a clearly identified pending proposal to settle? Use threads[].pendingSettle for the proposed option, including when this quote names a different option as a fallback. Require a clear link to the proposed option from this quote and preceding context. A condition on an unrelated option, vague concern, quoted or withdrawn condition, or unclear referent is false. If several proposals are pending, require a clear referent.`,
					"The speaker adds a specific condition to the identified pending proposal.",
					"No specific condition on an identified pending proposal.",
				);
				if (hasWithdrawalCue(candidates[index]!.quote)) {
					questions[`${prefix}withdraws_pending_settle`] = noul(
						`Does ${path} directly and unconditionally take back this speaker's own currently pending proposal to settle on a specific option? Use threads[].pendingSettle and preceding context to identify both the proposer and option. This is distinct from correcting a plan detail or reopening an already decided choice. Quoted, reported, hypothetical, conditional, and other-speaker withdrawals are false; if the proposal or option is unclear, answer false.`,
						"The proposer personally withdraws their identified pending option now.",
						"No direct withdrawal of that speaker's identified pending option.",
					);
				}
			}
		}
		if (threads.some((thread) => thread.status === "discarded")) {
			questions[`${prefix}raises_again`] = noul(
				`Does ${path} deliberately bring back a question the team already discarded, saying it should be considered again?`,
				"The speaker explicitly raises a discarded question again.",
				"The quote merely resembles a discarded question.",
			);
		}
		questions[`${prefix}reopening`] = noul(
			`Does ${path} itself directly request reopening a decision?`,
			"Direct reopening request.",
			"No direct reopening request.",
		);
		if (
			!(focusIndex !== undefined && pending.length && hasWithdrawalCue(candidates[index]!.quote))
		) {
			questions[`${prefix}material_objection`] = noul(
				`Does ${path} raise a substantive new concern that calls a current decision into question?`,
				"Material concern against a current decision.",
				"No material challenge to a current decision.",
			);
		}
	}
	let fourCandidateQuestions: Set<string> | undefined;
	// Four isolated requests share one durable targeting pass capped at 45 answers.
	if (candidates.length === MAX_QUOTE_CANDIDATES && !bareEditor) {
		fourCandidateQuestions = new Set();
		let include = (index: number, suffix: string) => {
			let key = `c${index}_${suffix}`;
			if (questions[key]) fourCandidateQuestions!.add(key);
		};
		let discarded = selected.some(({ thread }) => thread.status === "discarded");
		let decided = selected.some(({ thread }) => thread.status === "decided");
		let active = selected.some(({ thread }) =>
			["exploring", "leaning", "reopened"].includes(thread.status)
		);
		if ((discarded || decided) && active) {
			throw new Error("four-candidate mixed thread states exceed targeting budget");
		}
		let core = discarded
			? [
				"role",
				"thread",
				"option",
				"chosen_option",
				"new_option",
				"planning_substance",
				"duplicate",
				"relation",
			]
			: decided
			? [
				"role",
				"thread",
				"option",
				"chosen_option",
				"new_option",
				"planning_substance",
				"support",
				"objection",
				"duplicate",
			]
			: [...FOUR_CANDIDATE_QUESTIONS, "relation"];
		for (let index = 0; index < candidates.length; index++) {
			for (let suffix of core) include(index, suffix);
			if (discarded) {
				for (let suffix of ["raises_again", "reopening", "material_objection"]) {
					include(index, suffix);
				}
			} else if (decided) {
				include(index, "reopening");
				include(index, "material_objection");
			}
		}
		if (pending.length) {
			for (let index = 0; index < candidates.length; index++) {
				let quote = candidates[index]!.quote;
				let extra = hasWithdrawalCue(quote)
					? "withdraws_pending_settle"
					: /\b(?:if|unless|provided)\b/i.test(quote)
					? "qualifies_pending_settle"
					: "agrees_with_settle";
				let key = `c${index}_${extra}`;
				if (!questions[key]) continue;
				if (fourCandidateQuestions.size === 45) {
					fourCandidateQuestions.delete(`c${index}_explicit_resolution`);
				}
				fourCandidateQuestions.add(key);
			}
		}
		if (fourCandidateQuestions.size > 45) throw new Error("too many targeting questions");
	}
	return {
		state: fitState({
			current: {
				id: message.id,
				author: message.author,
				text: focus ? focus.quote : message.text.slice(0, 4000),
				...(compoundDecision
					? { fullMessage: message.text }
					: {}),
			},
			...(focus ? { preceding: message.text.slice(0, focus.start).slice(-300) } : {}),
			recent: recent.filter((entry) => entry.id !== message.id).slice(-12).map((entry) => ({
				id: entry.id,
				author: entry.author,
				text: entry.text.slice(0, 300),
			})),
			threads: compactThreads(selected, events, linkedCards),
			priorContributions,
			candidates: candidates.slice(0, focusIndex === undefined ? candidates.length : focusIndex + 1)
				.map((candidate) => ({
					quote: candidate.quote,
					start: candidate.start,
					end: candidate.end,
				})),
		}),
		questions: Object.fromEntries(
			Object.entries(questions).filter(([key]) => {
				if (focusIndex !== undefined && !key.startsWith(`c${focusIndex}_`)) return false;
				if (fourCandidateQuestions && !fourCandidateQuestions.has(key)) return false;
				if (!bareEditor) return true;
				return /_((?:role|thread|option|new_option|duplicate))$/.test(key);
			}),
		),
	};
}
