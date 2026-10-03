import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { createPolicyContext } from "./policy-context";
import { runInitialTerminals } from "./policy-initial-terminals";
import { inputFor, prefix, terminalPolicy } from "./policy-initial.test-fixtures";
import { MAX_EVENTS } from "./validation";
import type { Event } from "./policy-types";

let compound = "We need to choose how people sign in and how agents get credentials.";

test("quote budget rejects more than four candidates", () => {
	let input = inputFor(compound);
	input.candidates = Array.from({ length: 5 }, () => input.candidates[0]!);
	expect(() => createPolicyContext(input)).toThrow("source quote count exceeds 4");
});

test.each(["streaming", "empty", "system"] as const)(
	"ineligible %s returns no events",
	kind => {
		let input = inputFor(compound);
		if (kind === "streaming") input.message.streaming = true;
		if (kind === "empty") input.message.text = "";
		if (kind === "system") input.message.author = { kind: "system" };
		let context = createPolicyContext(input);
		expect(runInitialTerminals(context)).toEqual({
			events: [],
			candidates: [],
			outcomes: [],
			policyGate: "ineligible message",
		});
		expect(context.facts).toBeUndefined();
	},
);

test("attributed compound questions return review without opening threads", () => {
	let input = inputFor(
		"Alice said we need to choose how people sign in and how agents get credentials.",
	);
	let before = structuredClone(input);
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("compound decision attribution unclear");
	expect(result.events).toEqual([]);
	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["review", "review"]);
	expect(input).toEqual(before);
});

test("owned compound questions stage two exact openings atomically", () => {
	let input = inputFor(compound);
	let before = structuredClone(input);
	let result = terminalPolicy(input);
	expect(result.policyGate).toBe("explicit compound questions accepted");
	expect(result.events.map(event => event.type)).toEqual(["thread.opened", "thread.opened"]);
	expect(result.events.map(event => "source" in event ? event.source : undefined)).toEqual(
		input.candidates.map(candidate => ({
			messageId: input.message.id,
			author: input.message.author as ConversationPlan.SourceAuthor,
			quote: candidate.quote,
			start: candidate.start,
			end: candidate.end,
			role: "question",
		})),
	);
	expect(result.selectedTarget).toBe(result.events[0]!.threadId);
	expect(result.outcomes.map(outcome => outcome.eventIds)).toEqual(
		result.events.map(event => [event.id]),
	);
	expect(input).toEqual(before);
});

test("second compound opening failure discards the staged first opening and continues", () => {
	let input = inputFor(compound);
	// The event cap is exercised without inventing thousands of domain transitions.
	input.state.events = Array.from({ length: MAX_EVENTS - 1 }, (_, index): Event => ({
		id: `historical-${index}`,
		type: "thread.opened",
		threadId: `historical-thread-${index}`,
		observedThreadVersion: 0,
		origin: "human",
		actor: { kind: "member", handle: "Mina" },
		at: 999,
		question: "Historical question?",
	}));
	let before = structuredClone(input);
	let context = createPolicyContext(input);
	expect(runInitialTerminals(context)).toBeUndefined();
	expect(context.events).toEqual([]);
	expect(context.working).toBe(input.state);
	expect(input).toEqual(before);
});

test("eligible unhandled inputs expose facts and explicitly continue", () => {
	let input = inputFor("Useful chatter.");
	let context = createPolicyContext(input);
	expect(runInitialTerminals(context)).toBeUndefined();
	expect(context.facts?.exactDirectAlternatives).toBe(false);
	expect(context.events).toEqual([]);
	expect(prefix(input)).toBeUndefined();
});

test("continuation retains the quoted-option closure from the original message capture", () => {
	let input = inputFor("Should audit logs go in PostgreSQL or object storage?");
	let context = createPolicyContext(input);
	expect(runInitialTerminals(context)).toBeUndefined();
	context.message = { ...context.message, id: "changed-after-terminal-pass" };
	let option = context.quotedOption!(input.candidates[0]!, 0, "audit", input.state);
	expect(option.type).toBe("option.added");
	expect("source" in option && option.source?.messageId).toBe(input.message.id);
});
