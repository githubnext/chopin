import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { planEvents } from "./policy";
import { buildTriageRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { mockResult } from "./interpret.test-fixtures";
import { follow, message } from "./policy-initial.test-fixtures";

test("a first clause classified as both question and option keeps all three quoted options", () => {
	let current = message(
		"dual-role-options",
		"Should we use an off the shelf solution like Auth0? Or roll our own? Or use something like GitHub auth?",
		"Jules",
	);
	let quotes = extractQuotes(current.text);
	let triage = mockResult(buildTriageRequest(current, [], [], quotes).questions, {
		new_question: 0.97,
		new_option: 0.91,
		act: "question",
		thread_target: "new",
		significance: 2,
		c0_owned_unretracted: 0.93,
		c1_owned_unretracted: 0.94,
		c2_owned_unretracted: 0.94,
	}).answers;
	let opening = follow({ role: "question", thread: "new", threadProbability: 0.92 });
	opening.role = {
		type: "choice",
		choice: "question",
		confidence: 0.86,
		probabilities: { question: 0.89, option: 0.11 },
	};
	opening.thread.confidence = 0.84;
	opening.new_option = { type: "noul", noul: 0.91 };
	let second = follow({ role: "option", thread: "new" });
	second.role = {
		type: "choice",
		choice: "option",
		confidence: 0.76,
		probabilities: { option: 0.79, none: 0.21 },
	};
	second.thread = {
		type: "choice",
		choice: "new",
		confidence: 0.32,
		probabilities: { new: 0.66, none: 0.34 },
	};
	second.new_option = { type: "noul", noul: 0.94 };
	let third = follow({ role: "option", thread: "new" });
	third.role = {
		type: "choice",
		choice: "option",
		confidence: 0.94,
		probabilities: { option: 0.95, none: 0.05 },
	};
	third.thread = {
		type: "choice",
		choice: "new",
		confidence: 0.51,
		probabilities: { new: 0.75, none: 0.25 },
	};
	third.new_option = { type: "noul", noul: 0.94 };
	let output = planEvents({
		channelId: "channel",
		message: current,
		state: initialState(),
		first: triage,
		candidates: [opening, second, third].map((answers, index) => ({
			...quotes[index]!,
			answers,
		})),
	});
	expect(output.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
		"option.added",
		"option.added",
	]);
	expect(output.events[0]).toMatchObject({
		question: current.text,
		source: { quote: current.text, start: 0, end: current.text.length },
	});
	expect(
		output.events.slice(1).map(event =>
			"source" in event && event.source
				? { quote: event.source.quote, start: event.source.start, end: event.source.end }
				: undefined
		),
	)
		.toEqual(quotes.map(quote => ({ quote: quote.quote, start: quote.start, end: quote.end })));
});
