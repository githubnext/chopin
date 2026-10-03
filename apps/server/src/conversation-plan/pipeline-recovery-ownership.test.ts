import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { planEvents } from "./policy";
import { buildTriageRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { mockResult } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";

test.each([
	{
		name: "an unrelated opening question with no option evidence",
		text: "Who owns authentication? Use Auth0. Use GitHub auth.",
		role: "question",
		newOption: 0.05,
		expected: ["thread.opened"],
	},
	{
		name: "a generic concern even with a noisy option score",
		text: "I'm worried about login usability. Use Auth0. Use GitHub auth.",
		role: "objection",
		newOption: 0.95,
		expected: [],
	},
])("multi-option grouping rejects $name", ({ text, role, newOption, expected }) => {
	let current = message("unrelated-group", text, "Jules");
	let quotes = extractQuotes(current.text);
	let triage = mockResult(buildTriageRequest(current, [], [], quotes).questions, {
		new_question: 0.97,
		new_option: 0.95,
		act: "question",
		thread_target: "new",
		significance: 2,
	}).answers;
	let opening = follow({ role, thread: "new" });
	opening.new_option = { type: "noul", noul: newOption };
	let output = planEvents({
		channelId: "channel",
		message: current,
		state: initialState(),
		first: triage,
		candidates: quotes.map((quote, index) => ({
			...quote,
			answers: index === 0 ? opening : follow({ role: "option", thread: "new" }),
		})),
	});
	expect(output.events.map(event => event.type)).toEqual([...expected]);
	expect(output.events.some(event => event.type === "option.added")).toBe(false);
	if (role === "question") {
		expect(output.events[0]).toMatchObject({ question: quotes[0]!.quote });
	}
});

test("an unowned opening quote cannot bootstrap a multi-option thread", () => {
	let current = message(
		"reported-options",
		"Should we use Auth0? Or roll our own? Or use GitHub auth?",
		"Jules",
	);
	let quotes = extractQuotes(current.text);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state: initialState(),
		first: {
			...first({ new_question: 0.95, c0_owned_unretracted: 0.2 }),
			act: {
				type: "choice",
				choice: "question",
				confidence: 0.95,
				probabilities: { question: 0.95, none: 0.05 },
			},
			thread_target: {
				type: "choice",
				choice: "new",
				confidence: 0.95,
				probabilities: { new: 0.95, none: 0.05 },
			},
		},
		candidates: quotes.map((quote, index) => ({
			...quote,
			answers: follow({ role: "option", thread: index ? "none" : "new" }),
		})),
	});
	expect(output.events).toEqual([]);
	expect(output.outcomes[0]?.gate).toBe("source ownership unclear");
});
