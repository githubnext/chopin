import { expect, test } from "bun:test";
import { initialState, restoreState } from "./domain";
import { validAnswers } from "./pipeline-reply.test-fixtures";

test("JSON restore keeps typed answers and rejects unbounded legends", () => {
	let state = initialState();
	state.analysis.push({
		messageId: "synthetic",
		questionSetVersion: "v1",
		modelVersion: "jev-1.13.0",
		status: "unlinked",
		eventIds: [],
		passes: [{ stage: "triage", answers: structuredClone(validAnswers) as any }],
	});
	let restored = restoreState(JSON.parse(JSON.stringify(state)));
	expect((restored.analysis[0].passes[0].answers.level as any).legend["2"]).toBe("All");
	let unbounded = structuredClone(state);
	(unbounded.analysis[0].passes[0].answers.level as any).legend["2"] = "x".repeat(501);
	expect(() => restoreState(unbounded)).toThrow("legend");
	let malformed = structuredClone(state);
	(malformed.analysis[0].passes[0].answers.act as any).probabilities.yes = Infinity;
	expect(() => restoreState(malformed)).toThrow("probability");
	let bounded = structuredClone(state);
	bounded.analysis[0].outcomes = [{
		start: 0,
		end: 9,
		status: "review",
		gate: "unclear",
		eventIds: [],
	}];
	expect(restoreState(JSON.parse(JSON.stringify(bounded))).analysis[0].outcomes?.[0].gate)
		.toBe("unclear");
	bounded.analysis[0].outcomes[0].gate = "x".repeat(301);
	expect(() => restoreState(bounded)).toThrow("candidate outcome");
});

test("restores exactly 45 analysis answers and rejects a 46th", () => {
	let state = initialState();
	let answers = Object.fromEntries(Array.from({ length: 46 }, (_, index) => [
		`q${index}`,
		{ type: "noul" as const, noul: 0.5 },
	]));
	state.analysis.push({
		messageId: "bounded",
		questionSetVersion: "v4",
		modelVersion: "jev-1.13.0",
		status: "unlinked",
		eventIds: [],
		passes: [{
			stage: "targeting",
			answers: Object.fromEntries(
				Object.entries(answers).slice(0, 45),
			),
		}],
	});
	expect(Object.keys(
		restoreState(JSON.parse(JSON.stringify(state))).analysis[0].passes[0]
			.answers,
	)).toHaveLength(45);
	state.analysis[0].passes[0].answers = answers;
	expect(() => restoreState(JSON.parse(JSON.stringify(state)))).toThrow(
		"too many analysis questions",
	);
});
