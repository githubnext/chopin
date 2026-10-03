import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { planEvents } from "./policy";
import { buildTriageRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { mockResult } from "./interpret.test-fixtures";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";

test.each([
	{
		name: "When I Work",
		text: "We could use When I Work, Deputy, or Homebase.",
		options: ["When I Work", "Deputy", "Homebase"],
	},
	{
		name: "Asana",
		text: "We could use Asana, Linear, or Trello.",
		options: ["Asana", "Linear", "Trello"],
	},
])("a named three-option list can start with $name", ({ name, text, options }) => {
	let current = message(`named-options-${name}`, text, "Jules");
	let candidates = extractQuotes(text);
	expect(candidates.map(candidate => candidate.quote)).toEqual([...options]);
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
	expect(result.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
		"option.added",
		"option.added",
	]);
	expect(
		result.events.slice(1).map(event =>
			event.type === "option.added" ? event.contribution.text : ""
		),
	).toEqual([...options]);
});

test("multi-option grouping refuses a question longer than the event text bound", () => {
	let current = message(
		"long-options",
		`${"Background ".repeat(51)}Use Auth0. Use GitHub auth.`,
	);
	let quotes = ["Use Auth0.", "Use GitHub auth."];
	let candidates = quotes.map(quote => ({
		quote,
		start: current.text.indexOf(quote),
		end: current.text.indexOf(quote) + quote.length,
		answers: follow({ role: "option", thread: "none" }),
	}));
	expect(current.text.length).toBeGreaterThan(500);
	let triage = mockResult(buildTriageRequest(current, [], []).questions, {
		new_question: 0.97,
		act: "question",
		thread_target: "new",
	}).answers;
	expect(
		planEvents({
			channelId: "channel",
			message: current,
			state: initialState(),
			first: triage,
			candidates,
		}).events,
	).toEqual([]);
});
