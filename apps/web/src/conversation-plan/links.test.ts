import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";

import { jobsForMessage, messageLinks, threadForCard } from "./links";

let source = (
	messageId: string,
	role: ConversationPlan.SourceRole,
): ConversationPlan.SourceRef => ({
	messageId,
	author: { kind: "member", handle: "ana" },
	quote: "x",
	start: 0,
	end: 1,
	role,
});

let state = {
	schemaVersion: 1,
	revision: 3,
	queue: [],
	analysis: [],
	threads: [{
		id: "t1",
		question: "q",
		questionSources: [source("m1", "question")],
		questionAuthoring: "quoted",
		status: "reopened",
		contributions: [
			{
				id: "o1",
				kind: "option",
				text: "proposal",
				authoring: "quoted",
				sources: [source("m2", "option")],
				actor: { kind: "classifier" },
			},
			{
				id: "r1",
				kind: "reason",
				text: "reason",
				authoring: "quoted",
				sources: [source("m3", "reason")],
				actor: { kind: "classifier" },
			},
			{
				id: "c1",
				kind: "constraint",
				text: "constraint",
				authoring: "quoted",
				sources: [source("m4", "constraint")],
				actor: { kind: "classifier" },
			},
		],
		stances: [
			{
				id: "s1",
				participant: "bo",
				position: "support",
				sources: [source("m5", "support")],
				at: 1,
			},
			{
				id: "s2",
				participant: "cy",
				position: "oppose",
				sources: [source("m6", "objection")],
				at: 2,
			},
			{
				id: "s3",
				participant: "di",
				position: "neutral",
				sources: [source("m7", "support")],
				at: 3,
			},
		],
		stanceHistory: [],
		decision: {
			id: "d1",
			text: "decision",
			sources: [source("m8", "resolution")],
			actor: { kind: "member", handle: "ana" },
			at: 4,
		},
		decisionHistory: [],
		candidates: [
			{
				id: "ca1",
				kind: "resolution",
				text: "resolution",
				sources: [source("m9", "resolution")],
				status: "pending",
			},
			{
				id: "ca2",
				kind: "reopening",
				text: "reopen",
				sources: [source("m10", "reopening")],
				status: "pending",
			},
		],
		questionnaireId: "Q",
		version: 3,
	}],
	events: [
		{
			id: "e1",
			type: "settle.suggested",
			threadId: "t1",
			observedThreadVersion: 2,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1,
			source: source("m11", "resolution"),
			optionId: "o1",
		},
		{
			id: "e2",
			type: "decision.reopened",
			threadId: "t1",
			observedThreadVersion: 2,
			origin: "human",
			actor: { kind: "member", handle: "ana" },
			at: 2,
			explicit: true,
			source: source("m12", "reopening"),
		},
		{
			id: "e3",
			type: "thread.leaning",
			threadId: "t1",
			observedThreadVersion: 2,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 3,
			source: source("m13", "resolution"),
		},
	],
} as unknown as ConversationPlan.State;

test("threadForCard finds the linked thread", () => {
	expect(threadForCard(state, "Q")?.id).toBe("t1");
	expect(threadForCard(state, "nope")).toBeUndefined();
});

test("a prose job belongs to the linked question's opening message", () => {
	let prose = {
		id: "prose:Q:decided:Q:2",
		kind: "prose",
		target: "Q",
		trigger: "decided:Q:2",
		status: "failed",
		attempts: 1,
		reason: "Writer failed",
		at: "2026-09-25T10:00:00.000Z",
	} as ConversationPlan.Job;
	expect(jobsForMessage(state, [prose], "m1")).toEqual([prose]);
	expect(jobsForMessage(state, [prose], "m2")).toEqual([]);
	expect(jobsForMessage(state, [{ ...prose, target: "other" }], "m1")).toEqual([]);
});

test("badges name accepted roles only", () => {
	let labels = (messageId: string) => messageLinks(state, messageId).map(link => link.label);

	expect(labels("m1")).toEqual(["Question"]);
	expect(labels("m2")).toEqual(["Option"]);
	expect(labels("m3")).toEqual(["Reason"]);
	expect(labels("m4")).toEqual(["Constraint"]);
	expect(labels("m5")).toEqual(["Support"]);
	expect(labels("m6")).toEqual(["Objection"]);
	expect(labels("m7")).toEqual([]);
	expect(labels("m8")).toEqual([]);
	expect(labels("m9")).toEqual([]);
	expect(labels("m10")).toEqual(["Suggested reopening"]);
	expect(labels("m11")).toEqual(["Settle"]);
	expect(labels("m12")).toEqual(["Reopening"]);
	expect(labels("m13")).toEqual([]);
});
