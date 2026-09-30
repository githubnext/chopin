import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyEvent } from "./events";
import { effectivePending, effectivePreference } from "./preference";

function empty(): ConversationPlan.State {
	return { schemaVersion: 1, revision: 0, events: [], threads: [], queue: [], analysis: [] };
}
function opening(
	threadId = "thread-1",
	id = "open-1",
): Extract<ConversationPlan.Event, { type: "thread.opened" }> {
	return {
		id,
		threadId,
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		type: "thread.opened",
		question: "Which runtime?",
	};
}

test("replay clones an accepted event and advances the initial thread and revision", () => {
	let before = empty();
	let event = opening();
	let after = applyEvent(before, event);
	expect(before).toEqual(empty());
	expect(after.revision).toBe(1);
	expect(after.threads[0]!.version).toBe(1);
	expect(after.threads[0]!.question).toBe("Which runtime?");
	event.question = "Mutated caller input";
	expect(after.threads[0]!.question).toBe("Which runtime?");
	expect(after.events[0]).not.toBe(event);
});

function citation(
	role: ConversationPlan.SourceRole,
	quote = "Bun",
	handle = "maggie",
	messageId = "message-1",
): ConversationPlan.SourceRef {
	return {
		messageId,
		author: { kind: "member", handle },
		quote,
		start: 0,
		end: quote.length,
		role,
	};
}
function accept(
	state: ConversationPlan.State,
	body: Record<string, unknown>,
	threadId = "thread-1",
	human = false,
): ConversationPlan.State {
	return applyEvent(state, {
		id: `event-${state.events.length}`,
		threadId,
		observedThreadVersion: state.threads.find(thread => thread.id === threadId)!.version,
		origin: human ? "human" : "classifier",
		actor: human ? { kind: "member", handle: "maggie" } : { kind: "classifier" },
		at: state.events.length,
		...body,
	} as ConversationPlan.Event);
}
function withOption(): ConversationPlan.State {
	return accept(applyEvent(empty(), opening()), {
		type: "option.added",
		source: citation("option"),
		contribution: { id: "option-1", text: "Bun", authoring: "quoted" },
	});
}

test("event ID deduplication preserves the inherited return-before-validation behavior", () => {
	let current = applyEvent(empty(), opening());
	let duplicate = { ...opening(), question: "Different body", observedThreadVersion: 99 };
	expect(applyEvent(current, duplicate)).toBe(current);
	expect(applyEvent(current, { ...duplicate, question: "" })).toBe(current);
	expect(() =>
		applyEvent(current, {
			id: "stale",
			type: "thread.discarded",
			threadId: "thread-1",
			observedThreadVersion: 0,
			at: 1,
			origin: "human",
			actor: { kind: "member", handle: "maggie" },
		})
	).toThrow("stale conversation thread version");
	expect(() => applyEvent(current, { ...opening(), id: "different" })).toThrow(
		"stale thread opening",
	);
	expect(() =>
		applyEvent(current, {
			id: "missing",
			type: "thread.discarded",
			threadId: "missing",
			observedThreadVersion: 0,
			at: 1,
			origin: "human",
			actor: { kind: "member", handle: "maggie" },
		})
	).toThrow("stale conversation thread version");
});

test("contribution, stance, link, and relabel replay retain exact source wording", () => {
	let original = withOption();
	let before = structuredClone(original);
	let current = accept(original, { type: "card.linked", questionnaireId: "card-1" });
	current = accept(current, {
		type: "stance.changed",
		source: citation("support"),
		optionId: "option-1",
		position: "support",
	});
	current = accept(current, {
		type: "stance.changed",
		source: citation("support", "Bun", "alex", "message-2"),
		optionId: "option-1",
		position: "support",
	});
	current = accept(current, {
		type: "thread.leaning",
		source: citation("support"),
		optionId: "option-1",
	});
	current = accept(current, {
		type: "option.relabeled",
		optionId: "option-1",
		label: "Bun runtime",
		observedCardRevision: 0,
		origin: "planner",
		actor: { kind: "agent" },
	});
	expect(original).toEqual(before);
	expect(current.threads[0]!.status).toBe("leaning");
	expect(current.threads[0]!.contributions[0]!.text).toBe("Bun");
	expect(current.threads[0]!.contributions[0]!.displayLabel).toBe("Bun runtime");
	expect(current.threads[0]!.stanceHistory).toHaveLength(2);
	expect(() =>
		accept(current, {
			type: "stance.changed",
			source: citation("support"),
			optionId: "unknown",
			position: "support",
		})
	).toThrow("unknown stance option");
	expect(() =>
		accept(current, {
			type: "reason.added",
			source: citation("reason"),
			contribution: { id: "reason-1", text: "Different", authoring: "quoted" },
		})
	).toThrow("quoted wording must match source");
});

test("candidate confirmation, explicit reopening, and discard preserve decision history", () => {
	let current = withOption();
	current = accept(current, {
		type: "candidate.proposed",
		source: citation("resolution", "Use Bun"),
		candidate: { id: "candidate-1", kind: "resolution", text: "Use Bun" },
	});
	current = accept(
		current,
		{ type: "candidate.confirmed", candidateId: "candidate-1" },
		"thread-1",
		true,
	);
	expect(current.threads[0]!.status).toBe("decided");
	expect(current.threads[0]!.decision!.text).toBe("Use Bun");
	current = accept(current, { type: "decision.reopened", explicit: true }, "thread-1", true);
	expect(current.threads[0]!.decision).toBeUndefined();
	expect(current.threads[0]!.decisionHistory).toHaveLength(1);
	current = accept(current, { type: "thread.discarded" }, "thread-1", true);
	expect(current.threads[0]!.status).toBe("discarded");
});

test("settle deferral blocks effective preference until its exact verification resumes it", () => {
	let current = withOption();
	current = accept(current, {
		type: "settle.suggested",
		source: citation("resolution", "Use Bun", "maggie", "proposal-message"),
		optionId: "option-1",
	});
	let proposalId = current.events.at(-1)!.id;
	current = accept(current, {
		type: "stance.changed",
		source: citation("withdrawal", "Wait", "maggie", "defer-message"),
		optionId: "option-1",
		position: "neutral",
	});
	current = accept(current, {
		type: "settle.deferred",
		source: citation("constraint", "Wait", "maggie", "defer-message"),
		proposalId,
	});
	let deferredEventId = current.events.at(-1)!.id;
	expect(effectivePending(current.threads[0]!, current.events)).toBeUndefined();
	expect(effectivePreference(current.threads[0]!, current.events)).toBeUndefined();
	expect(() =>
		accept(current, {
			type: "settle.resumed",
			source: citation("verification", "Verified"),
			proposalId,
			deferredEventId: "wrong",
		})
	).toThrow("verification does not target the active deferral");
	current = accept(current, {
		type: "settle.resumed",
		source: citation("verification", "Verified"),
		proposalId,
		deferredEventId,
	});
	expect(effectivePending(current.threads[0]!, current.events)?.optionId).toBe("option-1");
	expect(effectivePreference(current.threads[0]!, current.events)).toEqual({
		optionId: "option-1",
		messageIds: ["proposal-message"],
	});
});

test("moving a contribution advances both threads once and rejects stale targets", () => {
	let current = withOption();
	current = applyEvent(current, opening("thread-2", "open-2"));
	let before = structuredClone(current);
	let fromVersion = current.threads[0]!.version;
	let targetVersion = current.threads[1]!.version;
	expect(() =>
		accept(
			current,
			{
				type: "card.corrected",
				change: {
					kind: "move",
					contributionId: "option-1",
					targetThreadId: "thread-2",
					targetVersion: targetVersion + 1,
				},
			},
			"thread-1",
			true,
		)
	).toThrow("stale target thread version");
	let next = accept(
		current,
		{
			type: "card.corrected",
			change: {
				kind: "move",
				contributionId: "option-1",
				targetThreadId: "thread-2",
				targetVersion,
			},
		},
		"thread-1",
		true,
	);
	expect(current).toEqual(before);
	expect(next.threads[0]!.contributions).toHaveLength(0);
	expect(next.threads[1]!.contributions[0]!.targetId).toBe("thread-2");
	expect(next.threads[0]!.version).toBe(fromVersion + 1);
	expect(next.threads[1]!.version).toBe(targetVersion + 1);
	expect(next.revision).toBe(current.revision + 1);
	expect(next.events).toHaveLength(current.events.length + 1);
});
