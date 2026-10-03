import { expect, test } from "bun:test";
import { applyInference } from "./domain";
import { applyEvent } from "./events";
import {
	addMatchingThread,
	confidentChoice,
	inputFor,
	prefix,
	seedOptions,
	terminalPolicy,
} from "./policy-initial.test-fixtures";
import { MAX_EVENTS } from "./validation";

let question = "Should audit logs go in PostgreSQL or object storage?";

function recovery() {
	let input = inputFor(question);
	input.state = addMatchingThread(input, "audit");
	return input;
}

test.each(["audit", "new"])("an exact question recovers missing options with target %s", target => {
	let input = recovery();
	input.first.thread_target = confidentChoice(target);
	let before = structuredClone(input);
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("direct options recovered");
	expect(result.events.map(event => event.type)).toEqual(["option.added", "option.added"]);
	expect(result.events.map(event => event.observedThreadVersion)).toEqual([1, 2]);
	expect(result.events.map(event => "source" in event ? event.source?.quote : undefined))
		.toEqual(input.candidates.map(candidate => candidate.quote));
	expect(result.selectedTarget).toBe("audit");
	expect(input).toEqual(before);
});

test("partial recovery ignores existing wording and adds only its missing option", () => {
	let input = recovery();
	seedOptions(input, 1);
	let before = structuredClone(input);
	let result = terminalPolicy(input);
	expect(result.events).toHaveLength(1);
	expect(result.outcomes.map(outcome => outcome.gate)).toEqual([
		"option already exists",
		"accepted",
	]);
	expect(result.events[0]!.observedThreadVersion).toBe(2);
	expect(input).toEqual(before);
});

test("a complete repeated question returns a terminal result without new events", () => {
	let input = recovery();
	seedOptions(input, 2);
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("question already complete");
	expect(result.events).toEqual([]);
	expect(result.outcomes.every(outcome => outcome.gate === "option already exists")).toBe(true);
});

test("ambiguous exact matches and unclear targets are terminal without recovery", () => {
	let input = recovery();
	input.state = addMatchingThread(input, "other-audit");
	expect(terminalPolicy(input).policyGate).toBe("question recovery unclear");
	input = recovery();
	input.first.thread_target = confidentChoice("none");
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("question recovery unclear");
	expect(result.events).toEqual([]);
	expect(result.outcomes.every(outcome => outcome.status === "ignored")).toBe(true);
});

test("discarded exact questions fall through rather than being recovered", () => {
	let input = recovery();
	input.state = applyEvent(input.state, {
		id: "discard-audit",
		type: "thread.discarded",
		threadId: "audit",
		observedThreadVersion: 1,
		origin: "human",
		actor: { kind: "member", handle: "Mina" },
		at: 1001,
	});
	let before = structuredClone(input);
	expect(prefix(input)).toBeUndefined();
	expect(input).toEqual(before);
});

test("agent recovery preserves planner attribution and stable option identities", () => {
	let input = recovery();
	input.message.author = { kind: "agent" };
	let result = terminalPolicy(input);
	expect(result.events.map(event => event.origin)).toEqual(["planner", "planner"]);
	expect(result.events.map(event => event.actor)).toEqual([{ kind: "agent" }, { kind: "agent" }]);
	expect(terminalPolicy(input)).toEqual(result);
});

test("event cap rejection removes every staged recovery event", () => {
	let input = recovery();
	let opening = input.state.events[0]!;
	input.state.events = Array.from({ length: MAX_EVENTS - 1 }, (_, index) => ({
		...opening,
		id: `historical-${index}`,
	}));
	let before = structuredClone(input);
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("direct option recovery rejected");
	expect(result.events).toEqual([]);
	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["review", "review"]);
	expect(input).toEqual(before);
});

test("contribution cap rejection removes an earlier staged addition", () => {
	let input = recovery();
	let candidate = input.candidates[0]!;
	for (let index = 0; index < 63; index++) {
		let thread = input.state.threads[0]!;
		input.state = applyInference(input.state, {
			id: `reason-${index}`,
			type: "reason.added",
			threadId: thread.id,
			observedThreadVersion: thread.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: input.message.ts,
			source: {
				messageId: input.message.id,
				author: { kind: "member", handle: "Mina" },
				quote: candidate.quote,
				start: candidate.start,
				end: candidate.end,
				role: "reason",
			},
			contribution: {
				id: `reason-contribution-${index}`,
				text: candidate.quote,
				authoring: "quoted",
			},
		}, input.message);
	}
	let before = structuredClone(input);
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("direct option recovery rejected");
	expect(result.events).toEqual([]);
	expect(input).toEqual(before);
});
