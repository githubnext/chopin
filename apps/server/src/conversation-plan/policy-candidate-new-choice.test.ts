import { expect, test } from "bun:test";
import { replay } from "./domain";
import { runDirectNewChoice } from "./policy-candidate-new-choice";
import {
	newChoiceInput,
	pendingChoice,
	scopedFrame,
} from "./policy-candidate-scoped.test-fixtures";
import { effectivePending } from "./preference";
import { optionIdFor } from "./policy-identity";

test.each([false, true])(
	"direct new choice stages the exact option with competing=%s",
	competing => {
		let input = newChoiceInput();
		expect(replay(input.state.events)).toEqual(input.state);
		let { context, entry, role } = scopedFrame(input);
		if (competing) context.candidateRun!.competingMessageTargets.add("provider");
		let before = structuredClone(input);
		let version = context.working.threads[0]!.version;
		expect(runDirectNewChoice(context, entry, role)).toBeUndefined();
		expect(context.events.map(event => event.type)).toEqual(
			competing ? ["option.added"] : ["option.added", "settle.suggested"],
		);
		let option = context.events[0]!;
		if (option.type !== "option.added") throw new Error("expected option");
		expect(option.contribution.id).toBe(
			optionIdFor("channel", input.message.id, 0, input.message.ts),
		);
		expect(option.observedThreadVersion).toBe(version);
		if (!competing) expect(context.events[1]!.observedThreadVersion).toBe(version + 1);
		expect(entry.outcome.status).toBe(competing ? "review" : "accepted");
		expect(entry.outcome.gate).toBe(competing ? "competing choice needs review" : "accepted");
		expect(input).toEqual(before);
		expect(replay(context.working.events)).toEqual(context.working);
	},
);

test.each([false, true])(
	"effective pending choice controls the skip after withdrawn=%s",
	withdrawn => {
		let input = newChoiceInput();
		pendingChoice(input, withdrawn);
		expect(replay(input.state.events)).toEqual(input.state);
		let { context, entry, role } = scopedFrame(input);
		expect(role.thread!.pendingSettle).toBeDefined();
		expect(Boolean(effectivePending(role.thread!, context.working.events))).toBe(!withdrawn);
		expect(runDirectNewChoice(context, entry, role)).toBeUndefined();
		expect(context.events).toHaveLength(withdrawn ? 2 : 0);
		expect(entry.outcome.gate).toBe(withdrawn ? "accepted" : "competing choice needs review");
	},
);

// Batch-length controls do not claim replay consistency for repeated synthetic prior events.
test.each([10, 11])("preserves the original <=10 handler bound at %s prior batch events", count => {
	let { context, entry, role } = scopedFrame(newChoiceInput());
	context.events.push(...Array.from({ length: count }, () => context.working.events[0]!));
	let result = runDirectNewChoice(context, entry, role);
	expect(result).toBe(count === 10 ? undefined : true);
	expect(context.events).toHaveLength(count === 10 ? 12 : 11);
});

test("second source validation failure discards the local staged option", () => {
	let { context, entry, role } = scopedFrame(newChoiceInput());
	let working = context.working;
	let quote = entry.candidate.quote;
	let reads = 0;
	Object.defineProperty(entry.candidate, "quote", {
		get() {
			reads++;
			return reads < 3 ? quote : "No longer matches the transcript.";
		},
	});
	expect(runDirectNewChoice(context, entry, role)).toBeUndefined();
	expect(reads).toBe(3);
	expect(context.working).toBe(working);
	expect(context.events).toHaveLength(0);
	expect(entry.outcome.gate).toBe("new choice could not be suggested");
});

test.each(["events", "IDs"])(
	"partial %s push failure preserves old working and already pushed data",
	target => {
		let { context, entry, role } = scopedFrame(newChoiceInput());
		let working = context.working;
		if (target === "events") {
			context.events.push = function(this: typeof context.events, ...events) {
				Array.prototype.push.call(this, events[0]!);
				throw new Error("partial event push");
			};
		} else {entry.outcome.eventIds.push = function(this: typeof entry.outcome.eventIds, ...ids) {
				Array.prototype.push.call(this, ids[0]!);
				throw new Error("partial ID push");
			};}
		expect(runDirectNewChoice(context, entry, role)).toBeUndefined();
		expect(context.working).toBe(working);
		expect(context.events).toHaveLength(target === "events" ? 1 : 2);
		expect(entry.outcome.eventIds).toHaveLength(target === "events" ? 0 : 1);
		expect(entry.outcome.status).toBe("review");
		expect(entry.outcome.gate).toBe("new choice could not be suggested");
	},
);
