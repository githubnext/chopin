import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevQuestion, JevRequest } from "./jev";
import type { QuoteCandidate } from "./quotes";
import { assertQuoteBudget } from "./quote-budget";
import { compactThreads, fitState, threadChoices, visibleThreads } from "./question-context";
import { noul } from "./question-shared";

export function triageQuestions(): Record<string, JevQuestion> {
	return {
		new_question: noul(
			"Does current.text itself put forward a distinct unresolved planning decision or question for the group to answer? Require a concrete choice, tradeoff, or specific unknown that could be answered, even when phrased as a statement. A message merely announcing intent to figure out a topic or start planning is purpose, not a new question, even if no solution exists yet. Do not invent a decision from the broad topic.",
			"A concrete open decision or answerable question is raised, including a declarative choice between approaches.",
			"Only intent or a topic for planning is stated; no distinct question to resolve is posed.",
		),
		enough_purpose: noul(
			"Does current.text, with recent messages, name a concrete planning topic or problem and an intent to plan or choose an approach? A topic-level statement like 'we need to figure out what we are doing for auth' is enough for a broad title and one-sentence goal. Do not require a chosen solution, candidate options, or implementation details. Generic 'we need a plan' without a topic is false.",
			"A topic and intent to plan or choose it are clear, even if details are unresolved.",
			"There is no identifiable topic or no intent to plan it.",
		),
		new_option: noul(
			"Does current.text propose or personally name concrete alternatives for an open planning question? A first-person present explanation like 'By X I mean A or B' names two options even without 'should'. Exclude reported, quoted, negated, or withdrawn alternatives.",
			"A distinct course of action is proposed or personally named as an alternative.",
			"No distinct option; assent alone is not new.",
		),
		reason: noul(
			"Does current.text give a reason for or against a plan option?",
			"A causal or evaluative reason is stated.",
			"No reason is stated.",
		),
		constraint: noul(
			"Does current.text impose a requirement or limitation on a plan?",
			"A requirement or limitation is expressed.",
			"No plan constraint.",
		),
		evidence: noul(
			"Does current.text offer evidence relevant to a planning choice?",
			"A relevant observation or fact is offered.",
			"No evidence claim.",
		),
		assumption: noul(
			"Does current.text name an assumption behind a planning choice?",
			"A relevant assumption is stated.",
			"No assumption.",
		),
		support: noul(
			"Does the current speaker personally support an existing option in current.text?",
			"The speaker expresses support, including qualified support or assent.",
			"Support is quoted, sarcastic, or absent.",
		),
		objection: noul(
			"Does the current speaker personally object to a plan in current.text?",
			"The speaker expresses a substantive objection.",
			"No current objection.",
		),
		correction: noul(
			"Does current.text correct earlier planning information?",
			"The speaker corrects a previously stated plan detail.",
			"No correction.",
		),
		withdrawal: noul(
			"Does current.text directly retract the current speaker's own earlier proposal or preference for a planning option? Require an explicit withdrawal in the speaker's own words; a correction of a detail, quotation, reported speech, hypothetical condition, or another person's withdrawal is false.",
			"The speaker explicitly takes back their own earlier proposal or preference.",
			"No direct personal withdrawal is stated.",
		),
		explicit_resolution: noul(
			"Does current.text itself propose that the team settle on one definite option now, such as 'let's just go with X' or 'we decided X'? Judge only this speaker's own assertion. A question, reported or quoted decision, hedged preference, or sarcasm is false.",
			"Proposal to settle now.",
			"No proposal to settle.",
		),
		reopening: noul(
			"Does current.text explicitly request reopening an already decided planning choice?",
			"A direct request to reopen a settled choice.",
			"Concern without explicit reopening, or no reopening.",
		),
		planner_request: noul(
			"Does current.text directly ask the Planner to act?",
			"A direct request to the Planner.",
			"No direct Planner request.",
		),
		research_need: noul(
			"Does the current speaker raise an unresolved need for current external cost or price information about two to four existing planning options? This may be a generic current-provider price unknown or a cost concern focused on one option. Require a useful unknown needing fresh outside research. A quoted, conditional, already answered, or merely local calculation is false. Judge this independently of whether the message adds a planning contribution.",
			"Fresh external cost information about existing options is needed.",
			"No grounded current external cost information is needed.",
		),
		act: {
			type: "choice",
			instructions:
				"What is the current speaker's primary discourse act in current.text? Judge the speaker's own words, not quotations or reported consensus.",
			criteria: {
				question:
					"Raises an unresolved planning question, including a declarative 'we need to choose how ...' or 'we need to decide how ...' without a question mark.",
				proposal:
					"Suggests a concrete answer, plan, or option; not merely that we need to choose how or that a choice is needed.",
				evaluation: "Evaluates, supports, or objects to a plan.",
				commitment: "Explicitly settles the team's choice now.",
				correction: "Corrects an earlier plan detail.",
				other: "Chatter, quotation, report, sarcasm, or another act.",
			},
		},
		thread_target: {
			type: "choice",
			instructions:
				"Which one current planning thread does current.text mainly address? If there are no current threads and current.text clearly raises a distinct unanswered planning question, choose new. Use none only when no question or clear target is raised. Do not guess a target from a topic-only purpose statement; multi-claim quotes are targeted separately later.",
			criteria: {
				new: "An unanswered planning question is raised and no current thread represents it.",
				none: "No distinct planning question or clear current-thread target is raised.",
			},
		},
		relation: {
			type: "choice",
			instructions: "How does current.text relate to the planning idea it mentions?",
			criteria: {
				supports: "Supports it.",
				challenges: "Challenges it.",
				qualifies: "Adds a condition or nuance.",
				replaces: "Supersedes a prior statement.",
				unrelated: "No clear relation.",
			},
		},
		significance: {
			type: "score",
			instructions: "Rate the planning significance of current.text, excluding quoted claims.",
			criteria: [
				"Chatter or logistical aside",
				"Minor related remark",
				"Useful planning point",
				"Changes proposed work",
			],
		},
		commitment: {
			type: "score",
			instructions:
				"How much team commitment does the current speaker personally express in current.text? Do not credit quotations, reported commitments, consensus guesses, or sarcasm.",
			criteria: [
				"No team commitment",
				"Personal preference or proposal",
				"Tentative team agreement",
				"Explicit present team resolution",
			],
		},
		ambiguity: {
			type: "score",
			instructions: "How ambiguous is the intended planning meaning of current.text?",
			criteria: [
				"Clear",
				"Mostly clear",
				"Several plausible readings",
				"Needs human interpretation",
			],
		},
		novelty: {
			type: "score",
			instructions:
				"How novel is the substantive planning point in current.text relative to recent and threads?",
			criteria: [
				"Repeated or no point",
				"Restates with small nuance",
				"Substantive new detail",
				"New planning direction",
			],
		},
	};
}

/** A second judgment selects only existing IDs and one exact saved quote span. */
export function buildTriageRequest(
	message: Chat.Entry,
	recent: readonly Chat.Entry[],
	threads: readonly ConversationPlan.Thread[],
	candidates: readonly QuoteCandidate[] = [],
	events: readonly ConversationPlan.Event[] = [],
): JevRequest {
	assertQuoteBudget(candidates);
	let questions = triageQuestions();
	for (let index = 0; index < candidates.length; index++) {
		questions[`c${index}_owned_unretracted`] = noul(
			`Read all of current.text in order. Is candidates[${index}].quote the current speaker's own sincere, still-current contribution? It may be a question, option, reason, concern, support, or resolution; do not require its planning target to be clear. A later independent topic does not cancel it. But a later sentence can reveal that an earlier phrase was another person's words, or can withdraw or contradict the speaker's earlier stance. In those cases the earlier candidate is false even though the speaker typed it. Reported words, quotation, and sarcasm are false. Judge this exact source span rather than the message's overall stance.`,
			"The speaker owns this sincere contribution and did not later withdraw it.",
			"Attribution, quotation, sarcasm, or an earlier contribution withdrawn later.",
		);
	}
	let selected = visibleThreads(threads, events);
	questions.thread_target = {
		type: "choice",
		instructions:
			"Which one current planning thread does current.text mainly address? If there are no current threads and current.text clearly raises a distinct unanswered planning question, choose new. Use none only when no question or clear target is raised. Do not guess a target from a topic-only purpose statement; multi-claim quotes are targeted separately later.",
		criteria: {
			...threadChoices(selected),
			new: "An unanswered planning question is raised and no current thread represents it.",
			none: "No distinct planning question or clear current-thread target is raised.",
		},
	};
	return {
		state: fitState({
			current: { id: message.id, author: message.author, text: message.text.slice(0, 4000) },
			candidates: candidates.map(candidate => ({
				quote: candidate.quote,
				start: candidate.start,
				end: candidate.end,
			})),
			recent: recent.filter((entry) => entry.id !== message.id).slice(-12).map((entry) => ({
				id: entry.id,
				author: entry.author,
				text: entry.text.slice(0, 300),
			})),
			threads: compactThreads(selected, events),
		}),
		questions,
	};
}
