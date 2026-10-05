import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { interpretResearch, researchRequest } from "./research-interpreter";
import { message, mockResult } from "./interpret.test-fixtures";
import { triageQuestions } from "./question-triage";

export const researchJudgments = {
	research_warranted: 0.95,
	external: 0.95,
	owned: 0.95,
	clear_subject: 0.95,
	already_answered: 0.05,
	explicit_proposal: 0.95,
	material_change: 0.05,
	standalone: 0.95,
	research_source: "q0",
	existing_offer: "new",
};

test.each([
	"Maybe we should investigate Jev alternatives.",
	"We don't know whether this library supports offline use.",
	"Let's compare the published limits for the available providers.",
])("research can identify an opportunity without a decision: %s", async text => {
	let input = { message: message("research", text), recent: [], state: initialState() };
	let output = await interpretResearch(
		input,
		async request => mockResult(request.questions, researchJudgments),
	);
	expect(output.candidate?.source.quote).toBe(text);
	expect(output.candidate?.offerId).toBeUndefined();
	expect(output.analysis.questionSetVersion).toBe("conversation-research-1");
	expect(triageQuestions()).not.toHaveProperty("research_need");
});

test.each(
	[
		["research_warranted", 0.79, "no clear research need"],
		["external", 0.79, "not external research"],
		["owned", 0.79, "source ownership unclear"],
		["clear_subject", 0.79, "research subject unclear"],
		["already_answered", 0.21, "research need already answered"],
	] as const,
)("research rejects %s without changing decisions", async (key, value, gate) => {
	let state = initialState();
	let output = await interpretResearch({
		message: message("research", "Maybe investigate alternatives."),
		recent: [],
		state,
	}, async request => mockResult(request.questions, { ...researchJudgments, [key]: value }));
	expect(output.candidate).toBeUndefined();
	expect(output.analysis.policyGate).toBe(gate);
	expect(state).toEqual(initialState());
});

test("research context retains the whole current message to catch late retractions", () => {
	let text = "Investigate alternatives. " + "Background discussion. ".repeat(120)
		+ "Actually, don't research this.";
	let current = message("research", text);
	let built = researchRequest({ message: current, recent: [], state: initialState() });
	expect((built.request.state as { current: { text: string } }).current.text).toBe(text);
	expect(built.spans.every(span => text.slice(span.start, span.end) === span.quote)).toBe(true);
	expect(Object.keys(built.request.questions).length).toBeLessThanOrEqual(45);
});
