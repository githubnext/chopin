import { expect, test } from "bun:test";

import { unapprovedContext, unapprovedDecisions } from "./open-decisions";

import type { Record as DecisionRecord } from "../questions/records";

function record(
	id: string,
	status: DecisionRecord["status"],
	questions: Array<{ id: string; header: string; question: string; options?: string[] }>,
	answers?: DecisionRecord["answers"],
): DecisionRecord {
	return {
		id,
		status,
		origin: "planner",
		definition: {
			questions: questions.map(item => ({
				id: item.id,
				header: item.header,
				question: item.question,
				multiple: false,
				options: (item.options ?? []).map(label => ({
					id: `${item.id}-${label}`,
					label,
					description: "",
				})),
			})),
		},
		...(answers ? { answers } : {}),
		history: [],
		optionOrigins: {},
		editors: [],
	};
}

test("every unanswered question of an open or reopened decision is unapproved", () => {
	let records = [
		record("deploy", "open", [{
			id: "rollout",
			header: "Rollout",
			question: "How should we deploy?",
			options: ["Canary", "Rolling"],
		}]),
		record("cache", "reopened", [
			{ id: "expiry", header: "Expiry", question: "When does the cache expire?" },
			{ id: "size", header: "Size", question: "How large may it grow?" },
		], { expiry: "Daily" }),
		record("partly", "open", [
			{ id: "first", header: "First", question: "Which database?", options: ["Postgres"] },
			{ id: "second", header: "Second", question: "Which queue?" },
		], { first: "Postgres" }),
		record("settled", "answered", [{ id: "done", header: "Done", question: "Already decided?" }], {
			done: "Yes",
		}),
		record("dropped", "discarded", [{ id: "gone", header: "Gone", question: "Discarded?" }]),
		record("withdrawn", "cancelled", [{ id: "off", header: "Off", question: "Cancelled?" }]),
		record("lapsed", "expired", [{ id: "late", header: "Late", question: "Expired?" }]),
	];

	expect(unapprovedDecisions(records)).toEqual([
		{
			id: "deploy",
			questionId: "rollout",
			status: "open",
			prompt: "How should we deploy?",
			options: ["Canary", "Rolling"],
		},
		// A reopened decision needs every one of its questions answered again.
		{
			id: "cache",
			questionId: "expiry",
			status: "reopened",
			prompt: "When does the cache expire?",
			options: [],
		},
		{
			id: "cache",
			questionId: "size",
			status: "reopened",
			prompt: "How large may it grow?",
			options: [],
		},
		{ id: "partly", questionId: "second", status: "open", prompt: "Which queue?", options: [] },
	]);
});

test("the builder is told to use its best judgment and to put the list in each pull request", () => {
	let context = unapprovedContext([
		record("deploy", "open", [{
			id: "rollout",
			header: "Rollout",
			question: "How should we deploy?",
			options: ["Canary", "Rolling"],
		}]),
		record("cache", "reopened", [{
			id: "expiry",
			header: "Expiry",
			question: "When does the\ncache   expire?",
		}]),
	]);

	expect(context?.unapprovedDecisions.decisions.map(item => item.prompt)).toEqual([
		"How should we deploy?",
		"When does the\ncache   expire?",
	]);
	let { instructions, pullRequestSection } = context!.unapprovedDecisions;
	expect(instructions).toContain("best judgment");
	expect(instructions).toContain("never answer or close");
	expect(instructions).toContain("pullRequestSection");
	// Labelled as assumed, one line per decision, however the prompt was written.
	expect(pullRequestSection).toBe(
		[
			"## Assumed, not yet approved",
			"",
			"These decisions were still open when this was built, so it went ahead on best judgment. None has been answered.",
			"",
			"- How should we deploy? (Canary, Rolling)",
			"- When does the cache expire?",
			"",
		].join("\n"),
	);
});

test("a document with no open decision gives the builder nothing to assume", () => {
	expect(unapprovedContext([])).toBeUndefined();
	expect(
		unapprovedContext([
			record("settled", "answered", [{ id: "done", header: "Done", question: "Done?" }], {
				done: "Yes",
			}),
		]),
	).toBeUndefined();
});
