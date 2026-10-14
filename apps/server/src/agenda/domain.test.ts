import { expect, it } from "bun:test";
import { saveSchema, uniqueQuestions } from "./domain";

it("deduplicates superficial public-question variants without merging different work", () => {
	let base = {
		question: "How do products explain open versus resolved decisions?",
		reason: "Clarify status.",
		evidenceNeed: "Public examples.",
		priority: 1,
	};
	expect(
		uniqueQuestions([base, { ...base, question: base.question.toUpperCase() }, {
			...base,
			question: "What makes creating a decision discoverable?",
		}]),
	).toHaveLength(2);
});
it("rejects model authority and unsupported budgets in human scope updates", () => {
	expect(
		saveSchema.safeParse({
			expectedRevision: 0,
			scope: "An adequately bounded public scope",
			questions: [],
			owner: "model",
			maxAiCredits: 9999,
		}).success,
	).toBe(false);
});
