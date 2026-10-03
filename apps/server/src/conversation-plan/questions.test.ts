import { expect, test } from "bun:test";
import { extractQuotes } from "./quotes";
import { buildCandidateTargetingRequest, buildTriageRequest } from "./questions";
import { message, quotes, text } from "./question-builder.test-fixtures";

// Original callbacks: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, questions.test.ts.
// Final parameterized interpreter callback (two cases) awaits the interpreter/policy slice.

test("act criteria separate an unresolved choice invitation from a proposed answer", () => {
	let invitation = {
		...message,
		id: "D19-m1",
		text:
			"Before the repository pilot, we need to choose how people sign in and how the hosted agent gets repository credentials.",
	};
	let request = buildTriageRequest(invitation, [], [], extractQuotes(invitation.text));
	let act = request.questions.act;
	if (act?.type !== "choice") throw new Error("missing act choice");
	expect((request.state as { candidates: unknown[] }).candidates).toHaveLength(2);
	expect(act.criteria.question).toMatch(/need to (?:choose|decide) how/i);
	expect(act.criteria.question).toMatch(/declarative|without a question mark/i);
	expect(act.criteria.proposal).toMatch(/(?:concrete|specific).*(?:answer|plan|option)/i);
	expect(act.criteria.proposal).toMatch(
		/(?:not|without).*(?:need to choose|choice is needed|unresolved choice)/i,
	);
});

test("D19 m2 extracts four exact option quotes in order", () => {
	expect(quotes.map(({ quote, start, end }) => ({ quote, start, end }))).toEqual([
		{ quote: "GitHub OAuth", start: 35, end: 47 },
		{ quote: "email magic links", start: 51, end: 68 },
		{ quote: "each user’s GitHub token", start: 143, end: 167 },
		{ quote: "GitHub App installation token", start: 177, end: 206 },
	]);
});

test("triage includes all four D19 m2 options in its bounded candidate context", () => {
	let triage = buildTriageRequest(message, [], [], quotes);
	expect((triage.state as { candidates: unknown[] }).candidates).toHaveLength(4);
	expect(triage.questions.c3_owned_unretracted?.type).toBe("noul");
});

test("targeting accepts the fourth D19 m2 option candidate", () => {
	let fourth = buildCandidateTargetingRequest(message, [], [], quotes, 3);
	expect(fourth.questions.c3_role?.type).toBe("choice");
	expect((fourth.state as { current: { text: string } }).current.text).toBe(quotes[3]!.quote);
	expect((fourth.state as { candidates: unknown[] }).candidates).toHaveLength(4);
});

test("candidate builders reject input beyond the four-quote budget instead of truncating", () => {
	let remainderStart = quotes[3]!.end;
	let overBudget = [
		...quotes,
		{
			quote: text.slice(remainderStart),
			start: remainderStart,
			end: text.length,
		},
	];

	expect(() => buildTriageRequest(message, [], [], overBudget)).toThrow();
	expect(() => buildCandidateTargetingRequest(message, [], [], overBudget, 4)).toThrow();
});
