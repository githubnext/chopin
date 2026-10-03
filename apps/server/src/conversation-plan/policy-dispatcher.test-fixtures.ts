import { createPolicyContext } from "./policy-context";
import { addMatchingThread, follow, inputFor } from "./policy-initial.test-fixtures";
import { supportInput } from "./policy-candidate-application.test-fixtures";
import { directAlternativeQuotes, extractQuotes } from "./quotes";
import type { PolicyInput } from "./policy-types";

// Offline completion fixtures for archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// policy.ts1729–1769 and original candidate loop control. Original callbacks remain assigned whole.
export function fallbackInput(): PolicyInput {
	let input = inputFor("Should we use Alpha or Alpha?");
	input.candidates = directAlternativeQuotes(input.message.text).map(quote => ({
		...quote,
		answers: follow({ role: "question", thread: "new" }),
	}));
	input.first.c0_owned_unretracted = { type: "noul", noul: 0.69 };
	return input;
}
export function finalContext(input = fallbackInput()) {
	let context = createPolicyContext(input);
	context.directQuestion = true;
	context.outcomes = input.candidates.map(candidate => ({
		start: candidate.start,
		end: candidate.end,
		status: "ignored",
		gate: "no useful role",
		eventIds: [],
	}));
	return context;
}

export function multipleSupportInput(): PolicyInput {
	let input = supportInput(["Jules"]);
	let answers = input.candidates[0]!.answers;
	input.message.text = Array.from(
		{ length: 4 },
		(_, index) => `I support Alpha for reason ${index}.`,
	).join(" ");
	input.candidates = extractQuotes(input.message.text).map(quote => ({
		...quote,
		answers: structuredClone(answers),
	}));
	for (let index = 0; index < 4; index++) {
		input.first[`c${index}_owned_unretracted`] = { type: "noul", noul: 0.95 };
	}
	return input;
}

export function recoveryInput(): PolicyInput {
	let input = inputFor("Should audit logs go in PostgreSQL or object storage?");
	input.state = addMatchingThread(input, "audit");
	return input;
}
