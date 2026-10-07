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
	expect(output.analysis.policyVersion).toBe("research-admission-2");
	expect(triageQuestions()).not.toHaveProperty("research_need");
});

test.each(
	[
		["research_warranted", 0.79, "Research need below threshold: 79%; required 80%."],
		["external", 0.69, "External suitability below threshold: 69%; required 70%."],
		["owned", 0.79, "Source ownership below threshold: 79%; required 80%."],
		["research_subject", "unclear", "Subject clarity below threshold: 5%; required 80%."],
		["already_answered", 0.21, "Already-answered evidence above threshold: 21%; maximum 20%."],
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
	expect(result.analysis.admission?.checks).toContainEqual({
		signal: "subject_clarity",
		score: 0.9,
		threshold: 0.8,
		comparison: "minimum",
	});
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
	expect(result.analysis.admission?.path).toBe("existing-offer-update");
	expect(result.analysis.admission?.checks.some(check => check.signal === "research_warranted"))
		.toBe(false);
});

test("the reported borderline external score admits a strong, owned proposal with a clear subject", async () => {
	let input = {
		message: message("borderline", "Maybe we should research alternatives to Jev?"),
		recent: [],
		state: initialState(),
	};
	let result = await interpretResearch(input, async request => {
		let result = mockResult(request.questions, {
			...researchJudgments,
			research_warranted: 0.89,
			external: 0.79,
			owned: 0.88,
			already_answered: 0.18,
		});
		// The report omitted these probabilities; use an explicitly clear contextual distribution.
		result.answers.research_subject = {
			type: "choice",
			choice: "contextual",
			confidence: 0.27,
			probabilities: { explicit: 0.4, contextual: 0.47, unclear: 0.13 },
		};
		return result;
	});
	expect(result.candidate?.source.quote).toBe(input.message.text);
	expect(result.analysis.admission?.path).toBe("explicit-proposal");
	expect(result.analysis.admission?.checks).toContainEqual({
		signal: "external",
		score: 0.79,
		threshold: 0.7,
		comparison: "minimum",
	});
	let offered = applyResearchOpportunity(input.state, "channel", input, result);
	expect(offered.researchOffers).toHaveLength(1);
	expect(offered.researchOffers![0]!.status).toBe("offered");
	expect(offered.researchOffers![0]!.action).toBeUndefined();
});

test("a borderline external score does not promote an inferred opportunity", async () => {
	let result = await interpretResearch(
		{
			message: message("inferred", "We are unsure about the options."),
			recent: [],
			state: initialState(),
		},
		async request =>
			mockResult(request.questions, {
				...researchJudgments,
				explicit_proposal: 0.2,
				external: 0.79,
			}),
	);
	expect(result.candidate).toBeUndefined();
	expect(result.analysis.admission?.path).toBe("inferred-opportunity");
	expect(result.analysis.policyGate).toBe(
		"External suitability below threshold: 79%; required 80%.",
	);
});

test.each(
	[
		["Research how our retry implementation works.", { external: 0.1 }],
		["Maybe research alternatives?", { research_subject: "unclear" }],
		["Mina suggested researching it, but I disagree.", { owned: 0.1 }],
		["Investigate Redis alternatives. Actually, don't.", { owned: 0.05 }],
		["Research that question, which the report already answers.", { already_answered: 0.9 }],
	] as const,
)("strong intent cannot override another failed requirement: %s", async (text, scores) => {
	let result = await interpretResearch(
		{ message: message("guard", text), recent: [], state: initialState() },
		async request =>
			mockResult(request.questions, { ...researchJudgments, external: 0.79, ...scores }),
	);
	expect(result.candidate).toBeUndefined();
	expect(result.analysis.admission?.path).toBe("explicit-proposal");
});
