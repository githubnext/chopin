import { expect, test } from "bun:test";

import { changeSentence, changeText, messageOutcome } from "./outcome";

import type { CardChange } from "./outcome";

import type { ConversationPlan } from "@chopin/protocol";

function source(start: number, role = "option"): ConversationPlan.SourceRef {
	return {
		messageId: "message-1",
		author: { kind: "member", handle: "ana" },
		quote: `quote ${start}`,
		start,
		end: start + 1,
		role,
	} as ConversationPlan.SourceRef;
}

function state(): ConversationPlan.State {
	return {
		schemaVersion: 1,
		revision: 1,
		events: [],
		threads: [],
		queue: [],
		analysis: [],
	};
}

function research(
	status: ConversationPlan.ResearchAnalysis["status"],
	offerId?: string,
): ConversationPlan.ResearchAnalysis {
	return {
		messageId: "message-1",
		questionSetVersion: "q",
		modelVersion: "m",
		status,
		answers: {},
		policyGate: "gate",
		latencyMs: 1,
		...(offerId ? { offerId } : {}),
	};
}

function change(labels: string[], title = "Should we ship a small pilot?"): CardChange {
	return {
		threadId: "thread-1",
		title,
		labels,
		link: { threadId: "thread-1", itemId: "item", label: labels[0]!, source: source(0) },
	};
}

test("change sentences use verbs with the card title as the object", () => {
	expect(changeText(change(["Option"]))).toBe(
		"Added as an option to Should we ship a small pilot?",
	);
	expect(changeText(change(["Support"]))).toBe(
		"Counted as support for Should we ship a small pilot?",
	);
	expect(changeText(change(["Option", "Constraint"])))
		.toBe("Added an option and a constraint to Should we ship a small pilot?");
	expect(changeText(change(["Reason", "Support", "Objection"])))
		.toBe("Added a reason, support and an objection to Should we ship a small pilot?");
	expect(changeText(change(["Reopening"]))).toBe("Reopened Should we ship a small pilot?");
	expect(changeText(change(["Settle"])))
		.toBe("Marked Should we ship a small pilot? ready to settle");
});

test("a question that is the card title becomes the link itself", () => {
	expect(changeSentence(change(["Question"]), "Should we ship a small pilot?"))
		.toEqual({ before: "Started a decision", after: "" });
	expect(changeText(change(["Question"]), "Ship it now?"))
		.toBe("Started the decision Should we ship a small pilot?");
});

test("links on one card collapse into one change with its title", () => {
	let current = state();
	current.threads = [{
		id: "thread-1",
		question: "Should we ship a small pilot?",
		questionSources: [],
		questionAuthoring: "quoted",
		status: "exploring",
		contributions: [
			{
				id: "option",
				kind: "option",
				text: "Pilot",
				authoring: "quoted",
				sources: [source(0)],
				actor: { kind: "classifier" },
			},
			{
				id: "constraint",
				kind: "constraint",
				text: "Accessible",
				authoring: "quoted",
				sources: [source(4)],
				actor: { kind: "classifier" },
			},
		],
		stances: [],
		stanceHistory: [],
		decisionHistory: [],
		candidates: [],
		version: 1,
	}];
	let outcome = messageOutcome(current, "message-1");
	expect(outcome.changes).toHaveLength(1);
	expect(outcome.changes[0]!.title).toBe("Should we ship a small pilot?");
	expect(outcome.changes[0]!.labels).toEqual(["Option", "Constraint"]);
	expect(outcome.heading).toBe("Added to a decision");
	expect(outcome.tone).toBe("success");
});

test("a research offer leads instead of claiming nothing happened", () => {
	let current = state();
	current.analysis = [{
		messageId: "message-1",
		questionSetVersion: "q",
		modelVersion: "m",
		status: "unlinked",
		passes: [],
		eventIds: [],
	}];
	current.research = { queue: [], analysis: [research("applied", "offer-1")], retries: [] };
	let outcome = messageOutcome(current, "message-1");
	expect(outcome.heading).toBe("Research suggested");
	expect(outcome.research).toBe("offered");
	expect(outcome.failed).toEqual([]);
});

test("failed lanes are listed with the decision lane first", () => {
	let current = state();
	current.queue = [{ messageId: "message-1", status: "failed", attempts: 2, error: "boom" }];
	current.research = { queue: [], analysis: [research("failed")], retries: [] };
	let outcome = messageOutcome(current, "message-1");
	expect(outcome.failed).toEqual(["decision", "research"]);
	expect(outcome.heading).toBe("Couldn’t analyse this message");
	expect(outcome.tone).toBe("warning");
});

test("an unlinked message with no research reports no changes", () => {
	let current = state();
	current.research = { queue: [], analysis: [research("unlinked")], retries: [] };
	let outcome = messageOutcome(current, "message-1");
	expect(outcome.heading).toBe("No changes");
	expect(outcome.research).toBe("none");
	expect(outcome.tone).toBe("neutral");
});
