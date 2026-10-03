import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { type Effect, effectsFor, runEffects } from "./effects";
import { event, OPTION, sink, thread } from "./effects.test-fixtures";

// Whole callbacks from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts.
test("one sourced settle suggestion selects the card and queues a Save prompt", () => {
	let suggestion = event("settle.suggested", "settle-1", {
		optionId: OPTION,
		source: {
			messageId: "m2",
			author: { kind: "member", handle: "mina" },
			quote: "Lets do GitHub Apps",
			start: 0,
			end: 18,
			role: "resolution",
		},
	});
	let linked = {
		...initialState(),
		events: [suggestion],
		threads: [thread({
			questionnaireId: "Q",
			pendingSettle: { optionId: OPTION, proposer: "mina", messageId: "m2" },
		})],
	};
	expect(effectsFor(
		[suggestion],
		linked,
		undefined,
		new Map([["Q", { history: [] }]]),
	)).toEqual([{
		key: "suggest:settle-1",
		kind: "suggest",
		threadId: "t1",
		optionId: OPTION,
		messageIds: ["m2"],
	}, {
		key: "prompt:settle-1",
		kind: "prompt",
		threadId: "t1",
		optionId: OPTION,
		messageId: "m2",
		generation: 0,
		sourceMessageIds: ["m2"],
	}]);
});

test("a sourced agreement queues a prompt bound to the card's current generation", () => {
	let agreement = event("settle.agreed", "agree-1", {
		optionId: OPTION,
		source: {
			messageId: "m3",
			author: { kind: "member", handle: "jules" },
			quote: "Sounds good.",
			start: 0,
			end: 12,
			role: "support",
		},
	});
	let proposal = event("settle.suggested", "settle-1", {
		optionId: OPTION,
		source: {
			messageId: "m2",
			author: { kind: "member", handle: "mina" },
			quote: "Lets do GitHub Apps",
			start: 0,
			end: 18,
			role: "resolution",
		},
	});
	let linked = {
		...initialState(),
		events: [proposal, agreement],
		threads: [thread({
			questionnaireId: "Q",
			pendingSettle: { optionId: OPTION, proposer: "mina", messageId: "m2" },
		})],
	};
	expect(effectsFor(
		[agreement],
		linked,
		undefined,
		new Map([
			["Q", { history: [{ at: 1 }, { at: 1 }] }],
		]),
	)).toEqual([{
		key: "suggest:agree-1",
		kind: "suggest",
		threadId: "t1",
		optionId: OPTION,
		messageIds: ["m2", "m3"],
	}, {
		key: "prompt:agree-1",
		kind: "prompt",
		threadId: "t1",
		optionId: OPTION,
		messageId: "m3",
		generation: 2,
		sourceMessageIds: ["m2", "m3"],
	}]);
	let unlinked = {
		...linked,
		threads: [thread({ pendingSettle: linked.threads[0].pendingSettle })],
	};
	expect(effectsFor([agreement], unlinked, undefined, new Map())).toMatchObject([{}, {
		kind: "prompt",
		generation: 0,
	}]);
	expect(() => effectsFor([agreement], linked, undefined, new Map()))
		.toThrow("linked prompt card is missing");
});

test("a prompt defers until linked, receipts a closed card, and passes its captured generation", async () => {
	let linked = false;
	let delivered: Array<{ card: string; generation: number }> = [];
	let state = sink({
		target: () => linked ? { kind: "open", id: "Q" } : { kind: "unlinked" },
		prompt: async (card, generation) => void delivered.push({ card, generation }),
	});
	let prompt: Effect = {
		key: "prompt:agree-1",
		kind: "prompt",
		threadId: "t1",
		optionId: OPTION,
		messageId: "m3",
		generation: 0,
	};
	expect(await runEffects(state.deps, [prompt])).toBe(0);
	linked = true;
	expect(await runEffects(state.deps, [prompt])).toBe(1);
	expect(delivered).toEqual([{ card: "Q", generation: 0 }]);
	expect([...state.receipts]).toEqual(["prompt:agree-1"]);
	let closed = sink({ target: () => ({ kind: "closed" }) });
	expect(await runEffects(closed.deps, [prompt])).toBe(1);
	expect(closed.calls).toEqual([]);
});
