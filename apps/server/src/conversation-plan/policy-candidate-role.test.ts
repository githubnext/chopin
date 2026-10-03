import { expect, test } from "bun:test";
import { beginCandidate } from "./policy-candidate-entry";
import { captureCandidateRole } from "./policy-candidate-role";
import { candidateContext, roleInput } from "./policy-candidate-entry.test-fixtures";
import { groupInput } from "./policy-candidate.test-fixtures";
import { confidentChoice } from "./policy-initial.test-fixtures";

function capture(input = roleInput()) {
	let context = candidateContext(input);
	let entry = beginCandidate(context, 0, input.candidates[0]!)!;
	return { context, entry, frame: captureCandidateRole(context, entry) };
}

test("captures target, linked card and pending references once for later stages", () => {
	let input = roleInput();
	let thread = input.state.threads[0]!;
	thread.pendingSettle = { optionId: "alpha", proposer: "Jules", messageId: "proposal" };
	thread.questionnaireId = "card";
	let card = { cardId: "card", options: [{ id: "alpha", label: "Alpha" }] };
	input.linkedCards = new Map([["provider", card]]);
	let { context, frame } = capture(input);
	expect(frame!.target).toBe("provider");
	expect(frame!.option).toBe("alpha");
	expect(frame!.pending).toBe(thread.pendingSettle);
	expect(frame!.targetThread).toBe(thread);
	expect(frame!.thread).toBe(thread);
	expect(frame!.linkedCard).toBe(card);
	context.working = { ...context.working, threads: [] };
	input.linkedCards = new Map();
	expect(frame!.targetThread).toBe(thread);
	expect(frame!.pending).toBe(thread.pendingSettle);
	expect(frame!.linkedCard).toBe(card);
	expect(context.selectedTarget).toBe("provider");
});

test("a split reason/support judgment becomes a reason only with corroborated evidence", () => {
	let input = roleInput("reason", "This saves time because it reduces latency.");
	input.candidates[0]!.answers.role = {
		type: "choice",
		choice: "reason",
		confidence: 0.9,
		probabilities: { reason: 0.45, support: 0.44, none: 0.11 },
	};
	expect(capture(input).frame!.role).toBe("reason");
	input.first.reason = { type: "noul", noul: 0.79 };
	expect(capture(input).frame).toBeUndefined();
});

test("agreement corroboration uses pending proposer and option before role selection", () => {
	let input = roleInput("support", "Agreed.");
	input.state.threads[0]!.pendingSettle = {
		optionId: "alpha",
		proposer: "Jules",
		messageId: "proposal",
	};
	input.candidates[0]!.answers.support = { type: "noul", noul: 0.1 };
	input.candidates[0]!.answers.agrees_with_settle = { type: "noul", noul: 0.7 };
	expect(capture(input).frame!.role).toBe("support");
	input.state.threads[0]!.pendingSettle!.proposer = "Mina";
	expect(capture(input).frame).toBeUndefined();
});

test("qualified pending evidence retains its pending choice and changes the role to constraint", () => {
	let input = roleInput("reason", "Verify latency before choosing.");
	let thread = input.state.threads[0]!;
	thread.pendingSettle = { optionId: "alpha", proposer: "Jules", messageId: "proposal" };
	input.candidates[0]!.answers.relation = confidentChoice("qualifies");
	input.candidates[0]!.answers.qualifies_pending_settle = { type: "noul", noul: 0.8 };
	let { frame } = capture(input);
	expect(frame!.role).toBe("constraint");
	expect(frame!.qualifiedPending).toBe(true);
	expect(frame!.pending).toBe(thread.pendingSettle);
});

test("a strong owned recommendation changes an option role to resolution", () => {
	let input = roleInput("option", "We should use Alpha.");
	input.candidates[0]!.answers.support = { type: "noul", noul: 0.8 };
	let { frame } = capture(input);
	expect(frame!.role).toBe("resolution");
	expect(frame!.strongRecommendation).toBe(true);
});

test("an owned known-option commitment can corroborate a below-choice-threshold resolution", () => {
	let input = roleInput("resolution", "Let's use Alpha.");
	input.first.act = confidentChoice("commitment");
	input.candidates[0]!.answers.role = {
		type: "choice",
		choice: "resolution",
		confidence: 0.95,
		probabilities: { resolution: 0.7, none: 0.3 },
	};
	expect(capture(input).frame!.role).toBe("resolution");
});

test("a mixed proposed new choice remains an option before direct commitment evidence", () => {
	let input = roleInput("option", "A new provider.");
	input.candidates[0]!.answers.chosen_option = confidentChoice("new");
	input.candidates[0]!.answers.role = {
		type: "choice",
		choice: "resolution",
		confidence: 0.9,
		probabilities: { resolution: 0.45, option: 0.45, none: 0.1 },
	};
	let { frame } = capture(input);
	expect(frame!.role).toBe("option");
	expect(frame!.directNewChoice).toBe(false);
});

test("a direct novel recommendation is captured as a resolution without applying its option", () => {
	let input = roleInput("option", "We should use Novel.");
	input.candidates[0]!.answers.chosen_option = confidentChoice("new");
	input.candidates[0]!.answers.option = confidentChoice("new");
	input.candidates[0]!.answers.support = { type: "noul", noul: 0.8 };
	let { context, frame } = capture(input);
	expect(frame!.role).toBe("resolution");
	expect(frame!.directNewChoice).toBe(true);
	expect(context.events).toHaveLength(0);
});

test.each([0.79, 0.8])(
	"withdrawal cue checks owned proposal before role override: %s",
	strength => {
		let input = roleInput("reason", "I withdraw that choice.");
		input.first.withdrawal = { type: "noul", noul: strength };
		let { context, frame } = capture(input);
		if (strength < 0.8) {
			expect(frame).toBeUndefined();
			expect(context.outcomes[0]!.status).toBe("review");
			expect(context.outcomes[0]!.gate).toBe("pending withdrawal needs a clear owned proposal");
		} else expect(frame!.role).toBe("withdrawal");
	},
);

test("group retargeting preserves references captured before the target is overridden", () => {
	let context = candidateContext();
	let entry = beginCandidate(context, 0, context.input.candidates[0]!)!;
	let frame = captureCandidateRole(context, entry)!;
	expect(frame.target).toBe(context.candidateRun!.optionGroup!);
	expect(frame.thread).toBe(context.working.threads[0]!);
	expect(frame.targetThread).toBeUndefined();
	expect(frame.pending).toBeUndefined();
	expect(frame.linkedCard).toBeUndefined();
});

test("seen labels remain consumed after later role rejection", () => {
	let context = candidateContext();
	let entry = beginCandidate(context, 0, context.input.candidates[0]!)!;
	entry.candidate.answers.role = {
		type: "choice",
		choice: "reason",
		confidence: 0.1,
		probabilities: { reason: 0.4, none: 0.6 },
	};
	entry.candidate.answers.planning_substance = { type: "noul", noul: 0 };
	expect(captureCandidateRole(context, entry)).toBeUndefined();
	expect([...context.candidateRun!.seenOptionLabels]).toEqual(["alpha"]);
	expect(context.events).toHaveLength(1);
});

test("role none progresses while preserving the prior selected target", () => {
	let input = roleInput("none");
	let context = candidateContext(input);
	context.selectedTarget = "prior";
	let entry = beginCandidate(context, 0, input.candidates[0]!)!;
	expect(captureCandidateRole(context, entry)!.role).toBe("none");
	expect(context.selectedTarget).toBe("prior");
});

test("Planner stance rejection precedes selected-target mutation", () => {
	let input = roleInput("support", "Agreed.");
	input.message.author = { kind: "agent" };
	let { context, frame } = capture(input);
	expect(frame).toBeUndefined();
	expect(context.selectedTarget).toBeUndefined();
	expect(context.outcomes[0]!.gate).toBe("Planner cannot cast a human stance or decision");
});

test("selected target and outcome target survive the later discarded-thread skip", () => {
	let input = roleInput();
	input.state.threads[0]!.status = "discarded";
	let { context, frame } = capture(input);
	expect(frame).toBeUndefined();
	expect(context.selectedTarget).toBe("provider");
	expect(context.outcomes[0]!.targetId).toBe("provider");
	expect(context.outcomes[0]!.gate).toBe("thread discarded");
});

test("the sequential first question becomes an option only after group retargeting", () => {
	let input = groupInput(["Should we host locally?", "Or use a gateway?", "Or use keys?"]);
	input.candidates[0]!.answers.role = confidentChoice("question");
	let { context, frame } = capture(input);
	expect(context.candidateRun!.sequentialChoiceQuestions).toBe(true);
	expect(frame!.role).toBe("option");
	expect(frame!.target).toBe(context.candidateRun!.optionGroup!);
	expect(frame!.targetThread).toBeUndefined();
});

test("a question role can progress on a discarded thread", () => {
	let input = roleInput("question");
	input.state.threads[0]!.status = "discarded";
	let { context, frame } = capture(input);
	expect(frame!.role).toBe("question");
	expect(frame!.thread!.status).toBe("discarded");
	expect(context.selectedTarget).toBe("provider");
});
