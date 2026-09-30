import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";
import { d01RecordedOpening } from "./policy-terminal.test-fixtures";

test("D01 question recovery keeps purpose, source, and target guards", () => {
	let input = d01RecordedOpening();
	let firstClause = input.candidates[0]!;
	let purposeOnly = {
		...input,
		message: { ...input.message, text: firstClause.quote },
		candidates: [firstClause],
	};
	let unowned = structuredClone(input);
	unowned.first.c1_owned_unretracted = { type: "noul", noul: 0.1 };
	let wrongQuote = structuredClone(input);
	wrongQuote.candidates[1]!.quote = "what else are we comparing?";
	let weakQuestion = structuredClone(input);
	weakQuestion.first.new_question = { type: "noul", noul: 0.1 };
	let reported = message("d01-reported", `Rob said, "${input.message.text}"`, "Nia");
	let reportedQuestion = {
		...input,
		message: reported,
		candidates: extractQuotes(reported.text).map((quote, index) => ({
			...quote,
			answers: input.candidates[index]!.answers,
		})),
	};
	let competingThread = { ...input, state: seeded() };
	for (
		let guarded of [
			purposeOnly,
			unowned,
			wrongQuote,
			weakQuestion,
			reportedQuestion,
			competingThread,
		]
	) {
		expect(planEvents(guarded).events).toEqual([]);
	}
});

test("D01 recovery does not turn a confident first-clause resolution into a question", () => {
	let input = d01RecordedOpening();
	let current = {
		...input.message,
		text: "need to pick Lexical before comments get any deeper. what are we comparing?",
	};
	let candidates = extractQuotes(current.text).map((quote, index) => ({
		...quote,
		answers: structuredClone(input.candidates[index]!.answers),
	}));
	candidates[0]!.answers.role = {
		type: "choice",
		choice: "resolution",
		confidence: 0.95,
		probabilities: { resolution: 0.95, question: 0.01, none: 0.04 },
	};
	expect(planEvents({ ...input, message: current, candidates }).events).toEqual([]);
});
