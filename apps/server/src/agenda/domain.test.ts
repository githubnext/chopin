import { expect, it } from "bun:test";
import { saveSchema, supportsAgendaHarness, uniqueQuestions } from "./domain";

it("allows agendas only on server harnesses with isolated structured workers", () => {
	for (let harness of ["copilot-sdk", "atomic"]) {
		expect(supportsAgendaHarness(harness)).toBe(true);
	}
	for (let harness of ["pi", "remote", "unknown", "", "toString"]) {
		expect(supportsAgendaHarness(harness)).toBe(false);
	}
});

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
			maxSessions: 9999,
		}).success,
	).toBe(false);
});
