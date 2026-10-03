import { expect, test } from "bun:test";
import { type Effect, runEffects } from "./effects";
import { LATER, OPTION, sink } from "./effects.test-fixtures";

// Whole callbacks from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts.
test("a failed link retries the same card, then delivers options before refine", async () => {
	let linked = false;
	let failLink = true;
	let failOption = true;
	let state = sink({
		target: () => linked ? { kind: "open", id: "Q" } : { kind: "unlinked" },
		insertCard: async () => (state.calls.push("insert:Q"), "Q"),
		link: async () => {
			if (failLink) {
				failLink = false;
				throw new Error("link commit failed");
			}
			linked = true;
			state.calls.push("link:Q");
		},
		addOption: async () => {
			if (failOption) {
				failOption = false;
				throw new Error("option commit failed");
			}
			state.calls.push("option");
		},
		enqueueJob: async () => void state.calls.push("refine"),
	});
	let effects: Effect[] = [
		{
			key: "insert:t1",
			kind: "insert-card",
			threadId: "t1",
			header: "Auth",
			question: "Which auth system?",
			options: [],
			trigger: "open-1",
		},
		{
			key: "option:later",
			kind: "add-option",
			threadId: "t1",
			optionId: LATER,
			label: "Auth0",
			trigger: "add-1",
		},
		{
			key: "job:refine:Q",
			kind: "job",
			threadId: "t1",
			intent: { kind: "refine", target: "Q", trigger: "link-1" },
		},
	];
	expect(await runEffects(state.deps, effects)).toBe(0);
	expect(state.calls).toEqual(["insert:Q"]);
	expect(await runEffects(state.deps, effects)).toBe(1);
	expect(state.calls).toEqual(["insert:Q", "insert:Q", "link:Q"]);
	expect(state.calls).not.toContain("refine");
	expect(await runEffects(state.deps, effects)).toBe(2);
	expect(state.calls).toEqual(["insert:Q", "insert:Q", "link:Q", "option", "refine"]);
});

test("all quoted options project before a job, forwarding its raw intent and receipt key", async () => {
	let state = sink({
		addOption: async (_id, input) => void state.calls.push(input.label),
		enqueueJob: async (intent, key) => void state.calls.push(`${key}:${intent.trigger}`),
	});
	let effects: Effect[] = [
		{
			key: "option:first",
			kind: "add-option",
			threadId: "t1",
			optionId: OPTION,
			label: "First",
			trigger: "event-first",
		},
		{
			key: "job:suggest:Q:event-first",
			kind: "job",
			threadId: "t1",
			intent: { kind: "suggest", target: "Q", trigger: "event-first" },
		},
		{
			key: "option:second",
			kind: "add-option",
			threadId: "t1",
			optionId: LATER,
			label: "Second",
			trigger: "event-second",
		},
	];
	expect(await runEffects(state.deps, effects)).toBe(3);
	expect(state.calls).toEqual([
		"First",
		"Second",
		"job:suggest:Q:event-first:event-first",
	]);
});
