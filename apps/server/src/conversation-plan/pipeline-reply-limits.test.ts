import { expect, test } from "bun:test";
import { initialState, restoreState } from "./domain";
import { askJev } from "./jev";
import { buildTargetingRequest, QUESTION_SET_VERSION } from "./questions";
import { extractQuotes } from "./quotes";
import { mockResult, seeded } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";
import { reply } from "./pipeline-reply.test-fixtures";

test("keeps the expanded three-quote request within a 45-question bound", async () => {
	let questions = Object.fromEntries(
		Array.from({ length: 46 }, (_, index) => [
			`q${index}`,
			{ type: "noul" as const, instructions: "Is this true?" },
		]),
	);
	let calls = 0;
	let ask = (count: number) => {
		let selected = Object.fromEntries(Object.entries(questions).slice(0, count));
		return askJev({ state: {}, questions: selected }, {
			apiKey: "test-only",
			fetch: async () => {
				calls++;
				return reply(mockResult(selected, {}).answers);
			},
		});
	};
	expect(Object.keys((await ask(45)).answers)).toHaveLength(45);
	expect(calls).toBe(1);
	await expect(ask(46)).rejects.toThrow("invalid Jev request bounds");
	expect(calls).toBe(1);
});

test("three discarded-thread quotes fit the request and persisted answer bounds", async () => {
	let current = message("three-quotes", "Revisit A. Revisit B. Revisit C.");
	let threads = [{ ...seeded().threads[0], status: "discarded" as const }];
	let request = buildTargetingRequest(current, [], threads, extractQuotes(current.text));
	expect(Object.keys(request.questions)).toHaveLength(39);
	expect(Object.keys(request.questions).filter(key => key.endsWith("_duplicate"))).toEqual([]);
	let result = await askJev(request, {
		apiKey: "test-only",
		fetch: async () => reply(mockResult(request.questions, {}).answers),
	});
	expect(Object.keys(result.answers)).toHaveLength(39);
	let state = initialState();
	state.analysis.push({
		messageId: current.id,
		questionSetVersion: QUESTION_SET_VERSION,
		modelVersion: result.model,
		status: "unlinked",
		eventIds: [],
		passes: [{ stage: "targeting", answers: result.answers }],
	});
	expect(restoreState(state).analysis[0].passes[0].answers).toEqual(result.answers);
	let oversized = structuredClone(state);
	for (let index = 0; index < 7; index++) {
		oversized.analysis[0].passes[0].answers[`extra${index}`] = {
			type: "noul",
			noul: 0.5,
		};
	}
	expect(() => restoreState(oversized)).toThrow("too many analysis questions");
});
