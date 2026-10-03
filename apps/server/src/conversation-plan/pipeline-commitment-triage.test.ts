import { expect, test } from "bun:test";
import { buildTargetingRequest, buildTriageRequest, QUESTION_SET_VERSION } from "./questions";
import { extractQuotes } from "./quotes";
import { seeded } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("candidate corroboration stays within the bounded second batch", () => {
	let current = message("batch", "Use an outline. Keep it optional. Remember my choice.");
	let request = buildTargetingRequest(current, [], seeded().threads, extractQuotes(current.text));
	expect(QUESTION_SET_VERSION).toBe("conversation-plan-8");
	// The seeded thread has no prior contributions, so none of the three spans asks duplicate.
	expect(Object.keys(request.questions)).toHaveLength(36);
	expect(Object.keys(request.questions).filter(key => key.endsWith("_duplicate"))).toEqual([]);
	expect(request.questions.c2_new_option?.type).toBe("noul");
	expect(request.questions.c2_objection?.type).toBe("noul");
});

test("question set four asks about purpose and re-raising only when discarded threads exist", () => {
	let current = message("question-set", "Should we revisit the outline?");
	let threads = seeded().threads;
	let triage = buildTriageRequest(current, [], threads);
	expect(triage.questions.enough_purpose?.type).toBe("noul");
	expect(triage.questions.explicit_resolution?.instructions).toContain("propose");
	let candidate = extractQuotes(current.text);
	let active = buildTargetingRequest(current, [], threads, candidate);
	expect(active.questions.c0_raises_again).toBeUndefined();
	let discardedThreads = [{ ...threads[0], status: "discarded" as const }];
	let discarded = buildTargetingRequest(current, [], discardedThreads, candidate);
	expect(discarded.questions.c0_raises_again?.type).toBe("noul");
	expect(discarded.questions.c0_explicit_resolution?.instructions).toContain("propose");
});

test("purpose triage accepts a named planning topic without requiring a chosen approach", () => {
	let auth = buildTriageRequest(
		message("auth-purpose", "Okay we gotta figure out what we're doing for auth"),
		[],
		[],
	);
	let vague = buildTriageRequest(message("vague", "We need to make a plan soon"), [], []);
	let purpose = auth.questions.enough_purpose;
	expect(purpose?.type).toBe("noul");
	if (purpose?.type !== "noul") throw new Error("purpose question is missing");
	expect(purpose.instructions).toContain("concrete planning topic");
	expect(purpose.instructions).toContain("Do not require a chosen solution");
	expect(purpose.criteria?.true).toContain("topic and intent to plan");
	expect(purpose.criteria?.false).toContain("no identifiable topic");
	expect((auth.state as { current: { text: string } }).current.text).toContain("auth");
	expect((vague.state as { current: { text: string } }).current.text).toBe(
		"We need to make a plan soon",
	);
});

test("question triage separates planning purpose from a distinct answerable choice", () => {
	let request = buildTriageRequest(
		message("auth-purpose", "Okay we gotta figure out what we're doing for auth"),
		[],
		[],
	);
	let question = request.questions.new_question;
	expect(question?.type).toBe("noul");
	if (question?.type !== "noul") throw new Error("new question triage is missing");
	expect(question.instructions).toContain("distinct unresolved planning decision");
	expect(question.instructions).toContain("even when phrased as a statement");
	expect(question.instructions).toContain("merely announcing intent");
	expect(question.criteria?.true).toContain("declarative choice");
	expect(question.criteria?.false).toContain("no distinct question");
});

test("triage selects a new target for an unanswered question with no current thread", () => {
	let request = buildTriageRequest(
		message("new-target", "Should we use Auth0 or build our own authentication?"),
		[],
		[],
	);
	let target = request.questions.thread_target;
	expect(target?.type).toBe("choice");
	if (target?.type !== "choice") throw new Error("thread targeting is missing");
	expect(target.instructions).toContain("If there are no current threads");
	expect(target.criteria.new).toContain("unanswered planning question");
	expect(target.criteria.none).toContain("No distinct planning question");
});
