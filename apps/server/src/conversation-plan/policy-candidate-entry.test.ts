import { expect, test } from "bun:test";
import { beginCandidate } from "./policy-candidate-entry";
import { candidateContext, roleInput } from "./policy-candidate-entry.test-fixtures";
import { groupInput } from "./policy-candidate.test-fixtures";
import { capEvents } from "./policy-terminal.test-fixtures";
import { MAX_EVENTS } from "./validation-fields";

test.each(["mismatched span", "empty quote", "oversized quote"])(
	"pushes outcome before rejecting %s",
	kind => {
		let context = candidateContext(roleInput());
		let candidate = context.input.candidates[0]!;
		if (kind === "mismatched span") candidate.start += 1;
		if (kind === "empty quote") {
			candidate.quote = "";
			candidate.end = candidate.start;
		}
		if (kind === "oversized quote") {
			candidate.quote = "x".repeat(2049);
			context.message.text = candidate.quote;
			candidate.start = 0;
			candidate.end = candidate.quote.length;
		}
		context.first.c0_owned_unretracted = { type: "noul", noul: 0 };
		expect(beginCandidate(context, 0, candidate)).toBeUndefined();
		expect(context.outcomes).toEqual([{
			start: candidate.start,
			end: candidate.end,
			status: "ignored",
			gate: "invalid source quote",
			eventIds: [],
		}]);
		expect(context.events).toHaveLength(0);
	},
);

test("ownership rejection follows source validation and keeps its ignored outcome", () => {
	let context = candidateContext(roleInput());
	context.first.c0_owned_unretracted = { type: "noul", noul: 0.69 };
	expect(beginCandidate(context, 0, context.input.candidates[0]!)).toBeUndefined();
	expect(context.outcomes[0]!.gate).toBe("source ownership unclear");
});

test("opening updates working and event IDs before consuming the first cached label", () => {
	let context = candidateContext();
	let before = structuredClone(context.input);
	let entry = beginCandidate(context, 0, context.input.candidates[0]!)!;
	expect(entry.outcome).toBe(context.outcomes[0]!);
	expect(entry.candidate).toBe(context.input.candidates[0]!);
	expect(entry.index).toBe(0);
	expect(context.events.map(event => event.type)).toEqual(["thread.opened"]);
	expect(entry.outcome.eventIds).toEqual([context.events[0]!.id]);
	expect(context.working.threads[0]!.id).toBe(context.candidateRun!.optionGroup!);
	expect([...context.candidateRun!.seenOptionLabels]).toEqual(["alpha"]);
	expect(context.input).toEqual(before);
});

test("domain failure clears the group and keeps later ownership checks active", () => {
	let input = groupInput();
	capEvents(input, MAX_EVENTS);
	let context = candidateContext(input);
	let oldWorking = context.working;
	expect(beginCandidate(context, 0, input.candidates[0]!)).toBeUndefined();
	expect(context.working).toBe(oldWorking);
	expect(context.candidateRun!.optionGroup).toBeUndefined();
	expect(context.outcomes[0]!.status).toBe("review");
	expect(context.outcomes[0]!.gate).toBe("multi-option question could not be opened");
	context.first.c1_owned_unretracted = { type: "noul", noul: 0 };
	expect(beginCandidate(context, 1, input.candidates[1]!)).toBeUndefined();
	expect(context.outcomes[1]!.gate).toBe("source ownership unclear");
});

test("an event push failure preserves the successfully applied opening in working", () => {
	let context = candidateContext();
	context.events.push = () => {
		throw new Error("event push");
	};
	expect(beginCandidate(context, 0, context.input.candidates[0]!)).toBeUndefined();
	expect(context.working.threads).toHaveLength(1);
	expect(context.working.events).toHaveLength(1);
	expect(context.events).toHaveLength(0);
	expect(context.candidateRun!.optionGroup).toBeUndefined();
	expect(context.outcomes[0]!.gate).toBe("multi-option question could not be opened");
});

test("an outcome ID push failure retains both the opening state and published event", () => {
	let context = candidateContext();
	context.outcomes.push = function(this: typeof context.outcomes, ...outcomes) {
		for (let outcome of outcomes) {
			outcome.eventIds.push = () => {
				throw new Error("ID push");
			};
		}
		return Array.prototype.push.apply(this, outcomes);
	};
	expect(beginCandidate(context, 0, context.input.candidates[0]!)).toBeUndefined();
	expect(context.working.threads).toHaveLength(1);
	expect(context.events).toHaveLength(1);
	expect(context.outcomes[0]!.eventIds).toHaveLength(0);
	expect(context.candidateRun!.optionGroup).toBeUndefined();
});

test("duplicate cached labels skip while the group opening and consumed labels survive", () => {
	let context = candidateContext();
	beginCandidate(context, 0, context.input.candidates[0]!);
	context.facts!.optionLabels[1] = "alpha";
	expect(beginCandidate(context, 1, context.input.candidates[1]!)).toBeUndefined();
	expect(context.outcomes[1]!.gate).toBe("duplicate option in new question");
	expect(context.events).toHaveLength(1);
	expect([...context.candidateRun!.seenOptionLabels]).toEqual(["alpha"]);
});

test("entry progression does not add a twelve-event guard", () => {
	let context = candidateContext(roleInput());
	let existing = candidateContext();
	beginCandidate(existing, 0, existing.input.candidates[0]!);
	context.events.push(...Array.from({ length: 12 }, () => existing.events[0]!));
	expect(beginCandidate(context, 0, context.input.candidates[0]!)).toBeDefined();
	expect(context.outcomes).toHaveLength(1);
});
