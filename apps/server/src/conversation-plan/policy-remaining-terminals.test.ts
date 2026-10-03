import { expect, test } from "bun:test";
import { inputFor } from "./policy-initial.test-fixtures";
import { runRemainingTerminals } from "./policy-remaining-terminals";
import {
	capEvents,
	d01RecordedOpening,
	declarativeInput,
	prepareRemaining,
	remainingPrefix,
	stateWithOption,
	terminalPolicy,
} from "./policy-terminal.test-fixtures";
import { MAX_EVENTS, MAX_THREADS } from "./validation";

let question = "Should audit logs go in PostgreSQL or object storage?";

test.each(["member", "agent"] as const)(
	"direct alternatives retain exact options and working state for %s",
	kind => {
		let input = inputFor(question);
		if (kind === "agent") input.message.author = { kind: "agent" };
		let before = structuredClone(input);
		let context = prepareRemaining(input);
		let result = runRemainingTerminals(context)!;
		expect(result.policyGate).toBe("direct alternatives accepted");
		expect(result.events.map(event => event.type)).toEqual([
			"thread.opened",
			"option.added",
			"option.added",
		]);
		expect(result.events.map(event => event.origin)).toEqual(
			Array(3).fill(kind === "agent" ? "planner" : "classifier"),
		);
		expect(result.outcomes.map(outcome => outcome.eventIds.length)).toEqual([2, 1]);
		expect(context.working.events).toEqual(result.events);
		expect(context.directQuestion).toBe(true);
		expect(input).toEqual(before);
		expect(terminalPolicy(input)).toEqual(result);
	},
);

test("direct opening rejection preserves the original working reference", () => {
	let input = inputFor(question);
	let seed = stateWithOption("Unrelated question?", "seed", "seed-option", "Seed option.");
	input.state.threads = Array.from(
		{ length: MAX_THREADS },
		(_, index) => ({ ...seed.threads[0]!, id: `seed-${index}` }),
	);
	let context = prepareRemaining(input);
	expect(runRemainingTerminals(context)?.policyGate).toBe("direct question rejected");
	expect(context.working).toBe(input.state);
});

test("direct option rejection retains successful opening and earlier addition in working", () => {
	let input = inputFor(question);
	capEvents(input, MAX_EVENTS - 2);
	let before = structuredClone(input);
	let context = prepareRemaining(input);
	let result = runRemainingTerminals(context)!;
	expect(result.policyGate).toBe("direct option rejected");
	expect(result.events).toEqual([]);
	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["review", "review"]);
	expect(context.working.events).toHaveLength(MAX_EVENTS);
	expect(context.working.threads[0]?.contributions).toHaveLength(1);
	expect(context.working).not.toBe(input.state);
	expect(input).toEqual(before);
});

test("quoted-option errors propagate while direct working retains earlier successes", () => {
	let input = inputFor(question);
	let context = prepareRemaining(input);
	let original = context.quotedOption!;
	context.quotedOption = (...args) => {
		if (args[1] === 1) throw new Error("quoted option failure");
		return original(...args);
	};
	expect(() => runRemainingTerminals(context)).toThrow("quoted option failure");
	expect(context.working.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
	]);
	expect(input.state.events).toEqual([]);
});

test("declarative batch rejection leaves staged state local", () => {
	let input = declarativeInput();
	capEvents(input, MAX_EVENTS - 1);
	let before = structuredClone(input);
	let context = prepareRemaining(input);
	let result = runRemainingTerminals(context)!;
	expect(result.policyGate).toBe("declarative options rejected");
	expect(result.events).toEqual([]);
	expect(context.working).toBe(input.state);
	expect(input).toEqual(before);
});

test("declarative quoted-option errors stay outside inference catches", () => {
	let input = declarativeInput();
	let context = prepareRemaining(input);
	let original = context.quotedOption!;
	context.quotedOption = (...args) => {
		if (args[1] === 1) throw new Error("quoted option failure");
		return original(...args);
	};
	expect(() => runRemainingTerminals(context)).toThrow("quoted option failure");
	expect(context.working).toBe(input.state);
});

test("purpose acceptance validates without replacing context working", () => {
	let input = d01RecordedOpening();
	let context = prepareRemaining(input);
	expect(runRemainingTerminals(context)?.policyGate).toBe(
		"owned purpose and final question accepted",
	);
	expect(context.working).toBe(input.state);
	expect(input.state.threads).toEqual([]);
});

test("purpose opening rejection continues without assigning working", () => {
	let input = d01RecordedOpening();
	capEvents(input, MAX_EVENTS);
	let context = prepareRemaining(input);
	expect(runRemainingTerminals(context)).toBeUndefined();
	expect(context.working).toBe(input.state);
	expect(context.directQuestion).toBe(false);
	expect(remainingPrefix(input)).toBeUndefined();
});

test("directQuestion survives continuation when bounds fail and later inputs change", () => {
	let input = inputFor("Should audit logs go in PostgreSQL or PostgreSQL?");
	let context = prepareRemaining(input);
	expect(context.facts?.exactDirectAlternatives).toBe(true);
	expect(context.facts?.directBounds).toBe(false);
	expect(runRemainingTerminals(context)).toBeUndefined();
	expect(context.directQuestion).toBe(true);
	context.working = stateWithOption("Other question?", "other", "other-option", "Other option.");
	context.first.new_question = { type: "noul", noul: 0 };
	context.facts!.exactDirectAlternatives = false;
	expect(context.directQuestion).toBe(true);
	expect(remainingPrefix(input)).toBeUndefined();
});

test("remaining stages and cached options use the initially captured message", () => {
	let input = inputFor(question);
	let original = input.message;
	let context = prepareRemaining(input);
	input.message = {
		...input.message,
		id: "changed-message",
		text: "Changed after initialization.",
	};
	let result = runRemainingTerminals(context)!;
	expect(result.policyGate).toBe("direct alternatives accepted");
	expect(result.events.map(event => "source" in event ? event.source?.messageId : undefined))
		.toEqual(Array(3).fill(original.id));
	expect(result.events[0]).toMatchObject({ question: original.text });
});
