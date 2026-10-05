import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { interpretResearch, researchRequest } from "./research-interpreter";
import { message, mockResult } from "./interpret.test-fixtures";
import { triageQuestions } from "./question-triage";
import { applyResearchOpportunity } from "./research-opportunities";

export const researchJudgments = {
	research_warranted: 0.95,
	external: 0.95,
	owned: 0.95,
	research_subject: "explicit",
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
		["research_subject", "unclear", "research subject unclear"],
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

test("explicit and contextual subject probabilities combine as clear rather than compete", async () => {
	let input = {
		message: message("contextual", "Investigate alternatives."),
		recent: [],
		state: initialState(),
	};
	let result = await interpretResearch(input, async request => {
		let result = mockResult(request.questions, { ...researchJudgments, standalone: 0.05 });
		result.answers.research_subject = {
			type: "choice",
			choice: "contextual",
			confidence: 0.1,
			probabilities: { explicit: 0.4, contextual: 0.5, unclear: 0.1 },
		};
		return result;
	});
	expect(result.candidate).toBeDefined();
	expect(result.candidate!.standalone).toBe(false);
});

test("a material requirement updates the sole matching offer without posing another research question", async () => {
	let initial = {
		message: message("first", "Research external queue providers."),
		recent: [],
		state: initialState(),
	};
	let first = await interpretResearch(
		initial,
		async request => mockResult(request.questions, researchJudgments),
	);
	let state = applyResearchOpportunity(initial.state, "channel", initial, first);
	let id = state.researchOffers![0]!.id;
	let result = await interpretResearch({
		message: message("scope", "We need self-hosting."),
		recent: [initial.message],
		state,
	}, async request => {
		let result = mockResult(request.questions, {
			...researchJudgments,
			research_warranted: 0.5,
			material_change: 0.95,
			existing_offer: id,
		});
		result.answers.existing_offer = {
			type: "choice",
			choice: id,
			confidence: 0.6,
			probabilities: { [id]: 0.74, new: 0.16, none: 0.1 },
		};
		return result;
	});
	expect(result.candidate).toMatchObject({ offerId: id, changed: true });
});
