import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { directAlternativeQuotes, extractQuotes } from "./quotes";
import {
	confidentChoice,
	first,
	follow,
	message,
	terminalPolicy as planEvents,
} from "./policy-initial.test-fixtures";

// Preserved from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/pipeline.test.ts.
test("high-confidence option labels cannot turn D03's question or grouped list into choices", () => {
	let text = "what sends transactional notifications? our SMTP relay, Postmark, or SES?";
	let current = message("d03-wrong-option-spans", text, "Liv");
	let quotes = [
		{ quote: text.slice(0, 39), start: 0, end: 39 },
		{ quote: text.slice(40, 73), start: 40, end: 73 },
	];
	let result = planEvents({
		channelId: "channel",
		message: current,
		state: initialState(),
		first: {
			...first({ new_question: 0.97, new_option: 0.99 }),
			act: confidentChoice("question"),
			thread_target: confidentChoice("new"),
			significance: {
				type: "score",
				score: 2,
				confidence: 0.95,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0.05, "2": 0.9, "3": 0.05 },
			},
		},
		candidates: quotes.map(quote => ({
			...quote,
			answers: {
				...follow({ role: "option", thread: "new" }),
				option: confidentChoice("new"),
				chosen_option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.99 },
				planning_substance: { type: "noul", noul: 0.99 },
				duplicate: { type: "noul", noul: 0.01 },
			},
		})),
	});
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
});
test.each([
	"Because this is our fallback, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
	"When configured, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
	"As Fallback, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications? our SMTP relay, Because, or SES?",
	"what sends transactional notifications? our SMTP relay, When configured, or SES?",
	"what sends transactional notifications? our SMTP relay, As Fallback, or SES?",
	"what sends transactional notifications if cost wins? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications when cost wins? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications according to Dan? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications as Dan reported? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications unless cost wins? our SMTP relay, Postmark, or SES?",
	"Dan said what sends transactional notifications? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications? our SMTP relay / Postmark, SES, or Mailgun?",
	"what sends transactional notifications? our SMTP relay is cheap, Postmark, or SES?",
	"what sends transactional notifications? our SMTP relay because cheap, Postmark, or SES?",
])("strong first-pass answers cannot turn unsafe D03 source spans into options: %s", text => {
	let current = message("d03-qualified-list", text, "Liv");
	let quotes = extractQuotes(text);
	let result = planEvents({
		channelId: "channel",
		message: current,
		state: initialState(),
		first: {
			...first({ new_question: 0.97, new_option: 0.99 }),
			act: confidentChoice("question"),
			thread_target: confidentChoice("new"),
			significance: {
				type: "score",
				score: 2,
				confidence: 0.95,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0.05, "2": 0.9, "3": 0.05 },
			},
		},
		candidates: quotes.map(quote => ({
			...quote,
			answers: {
				...follow({ role: "option", thread: "new" }),
				option: confidentChoice("new"),
				chosen_option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.99 },
				planning_substance: { type: "noul", noul: 0.99 },
				duplicate: { type: "noul", noul: 0.01 },
			},
		})),
	});
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
});
test.each([
	{
		name: "inline cost qualifier",
		text:
			"what sends transactional notifications when cost wins? our SMTP relay, Postmark, or SES?",
		candidates: [
			{ quote: "SMTP relay", start: 59, end: 69 },
			{ quote: "Postmark", start: 71, end: 79 },
			{ quote: "SES", start: 84, end: 87 },
		],
	},
	{
		name: "fallback rationale before the question",
		text:
			"Because this is our fallback, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		candidates: [
			{ quote: "SMTP relay", start: 74, end: 84 },
			{ quote: "Postmark", start: 86, end: 94 },
			{ quote: "SES", start: 99, end: 102 },
		],
	},
])("hand-supplied D03 spans from $name are reviewed atomically", ({ text, candidates }) => {
	let current = message("d03-exact-span-bypass", text, "Liv");
	expect(directAlternativeQuotes(text)).toEqual([]);
	for (let candidate of candidates) {
		expect(text.slice(candidate.start, candidate.end)).toBe(candidate.quote);
	}
	let result = planEvents({
		channelId: "channel",
		message: current,
		state: initialState(),
		first: {
			...first({ new_question: 0.97, new_option: 0.99 }),
			act: confidentChoice("question"),
			thread_target: confidentChoice("new"),
			significance: {
				type: "score",
				score: 2,
				confidence: 0.95,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0.05, "2": 0.9, "3": 0.05 },
			},
		},
		candidates: candidates.map(candidate => ({
			...candidate,
			answers: {
				...follow({ role: "option", thread: "new" }),
				option: confidentChoice("new"),
				chosen_option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.99 },
				planning_substance: { type: "noul", noul: 0.99 },
				duplicate: { type: "noul", noul: 0.01 },
			},
		})),
	});
	expect(result.events).toEqual([]);
	expect(result.outcomes.map(outcome => outcome.status)).toEqual([
		"review",
		"review",
		"review",
	]);
});
