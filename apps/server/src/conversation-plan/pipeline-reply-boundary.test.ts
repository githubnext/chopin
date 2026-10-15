import { expect, test } from "bun:test";
import { createDecide } from "./decisions";
import { decideReplying, fakeRegistry } from "./decisions.test-fixtures";
import { question, validAnswers } from "./pipeline-reply.test-fixtures";

test("retains complete choice distributions, the score legend and the answering model", async () => {
	let result = await decideReplying(validAnswers)({
		state: { current: { text: "Synthetic" } },
		questions: question,
	});
	expect(result.model).toBe("jev-latest");
	expect((result.answers.act as any).probabilities).toEqual({ yes: 0.9, no: 0.1 });
	expect(result.answers.level).toEqual({
		type: "score",
		score: 1.8,
		confidence: 0.8,
		legend: { "0": "None", "1": "Some", "2": "All" },
	});
});

test.each(
	[
		{ ...validAnswers, flag: { type: "noul", noul: Number.NaN } },
		{ ...validAnswers, act: { ...validAnswers.act, probabilities: { yes: 1 } } },
		{ ...validAnswers, act: { ...validAnswers.act, choice: "missing" } },
		{ ...validAnswers, level: { ...validAnswers.level, score: 500 } },
		{ ...validAnswers, extra: { type: "noul", noul: 0.5 } },
	] as const,
)("rejects malformed answer %#", async answers => {
	await expect(decideReplying(answers)({ state: "Synthetic", questions: question }))
		.rejects.toThrow("invalid");
});

test("bounds errors and aborts a stalled request", async () => {
	let settings = { model: "typesafe/jev-latest", timeoutMs: 30_000 };
	let failing = fakeRegistry(() => ({
		stopReason: "error",
		errorMessage: "System One API error (503): secret body",
	}));
	let failure = createDecide(failing, settings)({ state: "Synthetic", questions: question });
	await expect(failure).rejects.toThrow("503");
	await expect(failure).rejects.not.toThrow("secret");
	let abort = new AbortController();
	abort.abort();
	let stalled = fakeRegistry(() => new Promise(() => {}));
	await expect(
		createDecide(stalled, settings)({ state: "Synthetic", questions: question }, {
			signal: abort.signal,
		}),
	).rejects.toThrow("aborted");
});
