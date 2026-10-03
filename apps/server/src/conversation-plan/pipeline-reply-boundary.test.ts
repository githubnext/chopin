import { expect, test } from "bun:test";
import { askJev } from "./jev";
import { question, reply, validAnswers } from "./pipeline-reply.test-fixtures";

test("retains complete validated distributions and resolved model", async () => {
	let result = await askJev({ state: { current: { text: "Synthetic" } }, questions: question }, {
		apiKey: "test-only",
		fetch: async () => reply(validAnswers),
	});
	expect(result.model).toBe("jev-1.13.0");
	expect((result.answers.act as any).probabilities).toEqual({ yes: 0.9, no: 0.1 });
	expect((result.answers.level as any).probabilities).toEqual({ "0": 0.1, "1": 0, "2": 0.9 });
});

test.each(
	[
		[{ ...validAnswers, flag: { type: "noul", noul: Number.NaN } }, "invalid"],
		[{ ...validAnswers, act: { ...validAnswers.act, probabilities: { yes: 1 } } }, "invalid"],
		[{ ...validAnswers, act: { ...validAnswers.act, choice: "missing" } }, "invalid"],
		[{ ...validAnswers, level: { ...validAnswers.level, score: 500 } }, "invalid"],
		[{
			...validAnswers,
			level: { ...validAnswers.level, legend: { "0": "Wrong", "1": "Some", "2": "All" } },
		}, "invalid"],
		[{ ...validAnswers, extra: { type: "noul", noul: 0.5 } }, "invalid"],
	] as const,
)("rejects malformed answer %#", async (answers, error) => {
	await expect(askJev({ state: "Synthetic", questions: question }, {
		apiKey: "test-only",
		fetch: async () => reply(answers),
	})).rejects.toThrow(error);
});

test("bounds errors and aborts a stalled request", async () => {
	await expect(askJev({ state: "Synthetic", questions: question }, {
		apiKey: "test-only",
		fetch: async () => new Response("secret body", { status: 503 }),
	})).rejects.toThrow("503");
	let abort = new AbortController();
	abort.abort();
	await expect(askJev({ state: "Synthetic", questions: question }, {
		apiKey: "test-only",
		signal: abort.signal,
		fetch: async (_, init) => {
			if (init?.signal?.aborted) throw new Error("aborted");
			return reply(validAnswers);
		},
	})).rejects.toThrow();
});
