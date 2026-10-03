import { expect, test } from "bun:test";
import { prepareCandidateRun } from "./policy-candidate-setup";
import { choiceInput, groupInput, prepareCandidateContext } from "./policy-candidate.test-fixtures";
import { confidentChoice } from "./policy-initial.test-fixtures";
import { stableId } from "./policy-identity";

function setup(input = groupInput()) {
	return prepareCandidateRun(prepareCandidateContext(input));
}

test("groups bounded exact option spans with the original deterministic identity", () => {
	let input = groupInput();
	let before = structuredClone(input);
	let context = prepareCandidateContext(input);
	let run = prepareCandidateRun(context);
	expect(run.optionGroup).toBe(
		`thread:${stableId("channel", input.message.id, 0, "thread").slice(11)}`,
	);
	expect(run.sequentialChoiceQuestions).toBe(false);
	expect([...run.seenOptionLabels]).toEqual([]);
	expect([...run.competingMessageTargets]).toEqual([]);
	expect(context.candidateRun).toBe(run);
	expect(input).toEqual(before);
});

test("retains sequential question classification and its first question-role exception", () => {
	let input = groupInput(["Should we host locally?", "Or use a gateway?", "Or use keys?"]);
	input.candidates[0]!.answers.role = confidentChoice("question");
	let run = setup(input);
	expect(run.sequentialChoiceQuestions).toBe(true);
	expect(run.optionGroup).toBeDefined();
});

test.each([
	"ownership",
	"span",
	"new option",
	"role",
	"comma alternatives",
	"thread choice",
	"duplicate labels",
])("does not create an option group for invalid %s", kind => {
	let input = groupInput();
	let candidate = input.candidates[1]!;
	if (kind === "ownership") input.first.c1_owned_unretracted = { type: "noul", noul: 0.69 };
	if (kind === "span") candidate.start += 1;
	if (kind === "new option") candidate.answers.new_option = { type: "noul", noul: 0.74 };
	if (kind === "role") candidate.answers.role = confidentChoice("reason");
	if (kind === "comma alternatives") input = groupInput(["Alpha, Beta or Gamma", "Delta"]);
	if (kind === "thread choice") candidate.answers.thread = confidentChoice("provider");
	if (kind === "duplicate labels") input = groupInput(["Alpha", "alpha"]);
	expect(setup(input).optionGroup).toBeUndefined();
});

test("uses raw new/none thread choice for grouping despite low choice probabilities", () => {
	let input = groupInput();
	input.candidates[0]!.answers.thread = {
		type: "choice",
		choice: "new",
		confidence: 0.1,
		probabilities: { new: 0.1, none: 0.9 },
	};
	expect(setup(input).optionGroup).toBeDefined();
});

test.each([
	{ ids: ["alpha", "alpha"], expected: [] },
	{ ids: ["alpha", "beta"], expected: ["provider"] },
])("counts distinct known option IDs: $ids", ({ ids, expected }) => {
	expect([...setup(choiceInput(ids)).competingMessageTargets]).toEqual([...expected]);
});

test("accepts linked choices only from the thread's matching card", () => {
	let input = choiceInput(["linked-a", "linked-b"]);
	input.state.threads[0]!.questionnaireId = "card";
	input.linkedCards = new Map([["provider", {
		cardId: "card",
		options: [{ id: "linked-a", label: "A" }, { id: "linked-b", label: "B" }],
	}]]);
	expect([...setup(input).competingMessageTargets]).toEqual(["provider"]);
	input.linkedCards.get("provider")!.cardId = "wrong-card";
	expect([...setup(input).competingMessageTargets]).toEqual([]);
});

test.each([
	{ quotes: ["We should use Alpha.", "We should use alpha."], expected: [] },
	{ quotes: ["We should use Alpha.", "We should use Beta."], expected: ["provider"] },
])("normalizes novel recommendations for competition: $quotes", ({ quotes, expected }) => {
	let input = choiceInput(["new", "new"]);
	let spans = groupInput(quotes);
	input.message = spans.message;
	input.candidates.forEach((candidate, index) =>
		Object.assign(candidate, {
			start: spans.candidates[index]!.start,
			end: spans.candidates[index]!.end,
			quote: quotes[index],
		})
	);
	expect([...setup(input).competingMessageTargets]).toEqual([...expected]);
});

test.each(["agent", "decided", "discarded", "unowned", "wrong quote", "weak support"])(
	"excludes competing choices for %s",
	kind => {
		let input = choiceInput();
		if (kind === "agent") input.message.author = { kind: "agent" };
		if (kind === "decided" || kind === "discarded") input.state.threads[0]!.status = kind;
		if (kind === "unowned") input.first.c1_owned_unretracted = { type: "noul", noul: 0.69 };
		if (kind === "wrong quote") input.candidates[1]!.start += 1;
		if (kind === "weak support") {
			input.candidates[1]!.answers.support = { type: "noul", noul: 0.79 };
		}
		expect([...setup(input).competingMessageTargets]).toEqual([]);
	},
);

test("uses original input state and captured message rather than changed working/input", () => {
	let input = choiceInput();
	let context = prepareCandidateContext(input);
	context.working = { ...input.state, threads: [] };
	input.message = { ...input.message, text: "changed", author: { kind: "agent" } };
	expect([...prepareCandidateRun(context).competingMessageTargets]).toEqual(["provider"]);
});

test("uses cached option labels despite otherwise valid distinct candidate spans", () => {
	let context = prepareCandidateContext(groupInput());
	context.facts!.optionLabels = ["alpha", "alpha", "alpha"];
	expect(prepareCandidateRun(context).optionGroup).toBeUndefined();
});

test("owns fresh mutable sets and group state for each candidate run", () => {
	let a = setup();
	let b = setup();
	expect(a.seenOptionLabels).not.toBe(b.seenOptionLabels);
	expect(a.competingMessageTargets).not.toBe(b.competingMessageTargets);
	a.seenOptionLabels.add("alpha");
	a.competingMessageTargets.add("provider");
	a.optionGroup = undefined;
	expect([...b.seenOptionLabels]).toEqual([]);
	expect([...b.competingMessageTargets]).toEqual([]);
	expect(b.optionGroup).toBeDefined();
});

test("preserves competing-thread insertion order across four candidates", () => {
	let input = choiceInput(["alpha", "beta", "alpha", "beta"]);
	let provider = input.state.threads[0]!;
	let other = input.state.threads[1]!;
	other.contributions.push({ ...provider.contributions[0]! });
	input.candidates[0]!.answers.thread = confidentChoice("other");
	input.candidates[1]!.answers.thread = confidentChoice("other");
	expect([...setup(input).competingMessageTargets]).toEqual(["other", "provider"]);
});

test.each([
	{
		novel: false,
		linked: false,
		act: "commitment",
		resolution: 0,
		candidateResolution: 0,
		expected: ["provider"],
	},
	{
		novel: false,
		linked: true,
		act: "commitment",
		resolution: 0,
		candidateResolution: 0,
		expected: ["provider"],
	},
	{
		novel: false,
		linked: false,
		act: "proposal",
		resolution: 0.8,
		candidateResolution: 0.84,
		expected: [],
	},
	{
		novel: false,
		linked: false,
		act: "proposal",
		resolution: 0.8,
		candidateResolution: 0.85,
		expected: ["provider"],
	},
	{
		novel: true,
		linked: false,
		act: "commitment",
		resolution: 0.79,
		candidateResolution: 0.8,
		expected: [],
	},
	{
		novel: true,
		linked: false,
		act: "commitment",
		resolution: 0.8,
		candidateResolution: 0.8,
		expected: ["provider"],
	},
	{
		novel: true,
		linked: false,
		act: "proposal",
		resolution: 1,
		candidateResolution: 1,
		expected: [],
	},
])(
	"uses known/linked vs novel commitment evidence: $novel/$linked/$act/$resolution/$candidateResolution",
	({ novel, linked, act, resolution, candidateResolution, expected }) => {
		let input = choiceInput(
			novel ? ["new", "new"] : linked ? ["linked-a", "linked-b"] : ["alpha", "beta"],
		);
		if (linked) {
			input.state.threads[0]!.questionnaireId = "card";
			input.linkedCards = new Map([["provider", {
				cardId: "card",
				options: [{ id: "linked-a", label: "A" }, { id: "linked-b", label: "B" }],
			}]]);
		}
		let spans = groupInput(["Let's use Alpha.", "Let's use Beta."]);
		input.message = spans.message;
		input.first.act = confidentChoice(act);
		input.first.explicit_resolution = { type: "noul", noul: resolution };
		input.candidates.forEach((candidate, index) =>
			Object.assign(candidate, {
				start: spans.candidates[index]!.start,
				end: spans.candidates[index]!.end,
				quote: spans.candidates[index]!.quote,
			})
		);
		for (let candidate of input.candidates) {
			candidate.answers.explicit_resolution = { type: "noul", noul: candidateResolution };
		}
		expect([...setup(input).competingMessageTargets]).toEqual([...expected]);
	},
);
