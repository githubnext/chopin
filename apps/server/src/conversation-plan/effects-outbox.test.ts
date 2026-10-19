import { expect, test } from "bun:test";
import { type Effect, restoreEffectOutbox, runEffects } from "./effects";
import { LATER, OPTION, sink } from "./effects.test-fixtures";

// Whole callbacks from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts.
test("restored pending effects and receipts are strictly bounded", () => {
	let pending: Effect = {
		key: `option:${LATER}`,
		kind: "add-option",
		threadId: "t1",
		optionId: LATER,
		label: "Auth0",
		trigger: "add-1",
	};
	expect(restoreEffectOutbox([pending], ["insert:t1"])).toEqual({
		pending: [pending],
		receipts: ["insert:t1"],
	});
	expect(restoreEffectOutbox(undefined, undefined)).toEqual({ pending: [], receipts: [] });
	expect(() => restoreEffectOutbox([{ ...pending, surprise: true }], []))
		.toThrow("conversation effect");
	expect(() => restoreEffectOutbox([{ ...pending, optionId: "old-id" }], []))
		.toThrow("conversation effect");
	expect(() => restoreEffectOutbox([{ ...pending, optionId: [LATER] }], []))
		.toThrow("conversation effect");
	expect(() =>
		restoreEffectOutbox([{
			key: "insert:t1",
			kind: "insert-card",
			threadId: "t1",
			header: "Auth",
			question: "Which auth system?",
			options: [{ id: [LATER], label: "Auth0" }],
			trigger: "open-1",
		}], [])
	).toThrow("conversation effect");
	expect(() =>
		restoreEffectOutbox([{
			key: "suggest:settle-1",
			kind: "suggest",
			threadId: "t1",
			optionId: [LATER],
			messageIds: ["m1"],
		}], [])
	).toThrow("conversation effect");
	expect(() => restoreEffectOutbox([pending, pending], []))
		.toThrow("conversation effect");
	expect(() => restoreEffectOutbox([pending], [pending.key]))
		.toThrow("conversation effect");
	expect(() => restoreEffectOutbox([pending], Array.from({ length: 1025 }, (_, i) => `k${i}`)))
		.toThrow("conversation effect");
});

test("restored prompt effects require a bounded captured generation", () => {
	let prompt: Effect = {
		key: "prompt:agree-1",
		kind: "prompt",
		threadId: "t1",
		optionId: OPTION,
		messageId: "m3",
		generation: 0,
	};
	let refreshed = { ...prompt, sourceMessageIds: ["m6"] };
	expect(restoreEffectOutbox([refreshed], [])).toEqual({ pending: [refreshed], receipts: [] });
	let cleared = { ...prompt, optionId: undefined, sourceMessageIds: [] };
	delete cleared.optionId;
	expect(restoreEffectOutbox([cleared], [])).toEqual({ pending: [cleared], receipts: [] });
	expect(() => restoreEffectOutbox([{ ...prompt, sourceMessageIds: ["m6", "m6"] }], []))
		.toThrow("conversation effect");
	expect(restoreEffectOutbox([prompt], []).pending).toEqual([prompt]);
	for (let generation of [undefined, -1, 0.5, 2 ** 53]) {
		expect(() => restoreEffectOutbox([{ ...prompt, generation }], []))
			.toThrow("conversation effect");
	}
	expect(() => restoreEffectOutbox([{ ...prompt, optionId: "old" }], []))
		.toThrow("conversation effect");
});

test("restored prose effects require their linked thread", () => {
	expect(() =>
		restoreEffectOutbox([{
			key: "job:prose:Q:1",
			kind: "job",
			intent: { kind: "prose", target: "Q", trigger: "decided:Q:1" },
		}], [])
	).toThrow("conversation effect");
});

test("a why-only job effect has no thread, survives restore, and enqueues once", async () => {
	let effect: Effect = {
		key: "job:why:C:1",
		kind: "job",
		intent: { kind: "prose", target: "C", trigger: "why:C:1" },
	};
	expect(restoreEffectOutbox([effect], [])).toEqual({ pending: [effect], receipts: [] });
	// A paragraph write-up still needs its conversation thread.
	expect(() =>
		restoreEffectOutbox([{ ...effect, intent: { ...effect.intent, trigger: "decided:C:1" } }], [])
	).toThrow("conversation effect");
	let jobs: string[] = [];
	let state = sink({ enqueueJob: async intent => void jobs.push(intent.trigger) });
	expect(await runEffects(state.deps, [effect])).toBe(1);
	expect(await runEffects(state.deps, [effect])).toBe(0);
	expect(jobs).toEqual(["why:C:1"]);
});
