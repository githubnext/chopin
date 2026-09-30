import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { createPolicyContext } from "./policy-context";
import { runInitialTerminals } from "./policy-initial-terminals";
import { inputFor, prefix, terminalPolicy } from "./policy-initial.test-fixtures";
import { isAttributedCompoundDecision } from "./quotes";
import { MAX_EVENTS } from "./validation";
import type { Event } from "./policy-types";

let compound = "We need to choose how people sign in and how agents get credentials.";

test("quote budget rejects before reading message or initialization state", () => {
	let input = inputFor(compound);
	input.candidates = Array.from({ length: 5 }, () => input.candidates[0]!);
	Object.defineProperty(input, "message", {
		get() {
			throw new Error("message read too early");
		},
	});
	Object.defineProperty(input, "state", {
		get() {
			throw new Error("state read too early");
		},
	});
	expect(() => createPolicyContext(input)).toThrow("source quote count exceeds 4");
});

test.each(["streaming", "empty", "system"] as const)(
	"ineligible %s returns before reading thread facts",
	kind => {
		let input = inputFor(compound);
		if (kind === "streaming") input.message.streaming = true;
		if (kind === "empty") input.message.text = "";
		if (kind === "system") input.message.author = { kind: "system" };
		Object.defineProperty(input.state, "threads", {
			get() {
				throw new Error("facts read too early");
			},
		});
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

test("topic corroboration precedes compound attribution", () => {
	let text =
		"what sends notices? our relay, Alice said we need to choose how people sign in and how agents get credentials.";
	let input = inputFor(text);
	input.candidates = ["how people sign in", "how agents get credentials"].map(quote => {
		let start = text.indexOf(quote);
		return { quote, start, end: start + quote.length, answers: input.candidates[0]!.answers };
	});
	expect(isAttributedCompoundDecision(text, input.candidates)).toBe(true);
	expect(terminalPolicy(input).policyGate).toBe("topic alternatives need candidate corroboration");
});

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

test("facts retain the initialized message without rereading an input getter", () => {
	let input = inputFor("Should audit logs go in PostgreSQL or object storage?");
	let original = input.message;
	let reads = 0;
	Object.defineProperty(input, "message", {
		get() {
			reads++;
			return reads === 1 ? original : { ...original, text: "Changed after initialization." };
		},
	});
	let context = createPolicyContext(input);
	expect(runInitialTerminals(context)).toBeUndefined();
	expect(reads).toBe(1);
	expect(context.facts?.questionKey).toBe(original.text.toLowerCase());
	expect(context.facts?.exactDirectAlternatives).toBe(true);
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
