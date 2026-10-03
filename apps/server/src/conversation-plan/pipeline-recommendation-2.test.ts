import { expect, test } from "bun:test";
import type { JevQuestion } from "./jev";
import { buildTargetingRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId, settledBy, withOption } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("agreement targeting is requested only when a proposal is pending", () => {
	let current = message("assent", "Sounds good to me.", "alice");
	let candidates = [{ quote: current.text, start: 0, end: current.text.length }];
	let without = buildTargetingRequest(current, [], withOption(seeded()).threads, candidates);
	let withProposal = buildTargetingRequest(
		current,
		[],
		settledBy(seeded(), "bob").threads,
		candidates,
	);
	expect(without.questions.c0_agrees_with_settle).toBeUndefined();
	expect(withProposal.questions.c0_agrees_with_settle).toMatchObject({
		type: "noul",
		criteria: {
			true: "The speaker agrees with the pending proposal to settle.",
			false: "No agreement with a pending proposal.",
		},
	});
	expect(
		(withProposal.state as { threads: Array<{ pendingSettle?: unknown }> }).threads[0]
			.pendingSettle,
	).toEqual({
		optionId: seededOptionId,
		option: "Use an optional outline.",
		proposer: "bob",
	});
});

test("multiple pending proposals keep assent targeting explicitly ambiguous", () => {
	let state = settledBy(seeded(), "bob");
	let other = structuredClone(state.threads[0]!);
	other.id = "thread-b";
	other.question = "Should we add an optional sidebar?";
	other.contributions[0]!.id = "sidebar-option";
	other.contributions[0]!.text = "Add an optional sidebar.";
	other.pendingSettle = {
		optionId: "sidebar-option",
		proposer: "cara",
		messageId: "sidebar-proposal",
	};
	state.threads.push(other);
	let current = message(
		"ambiguous-assent",
		"Sounds good to me. What about agent access?",
		"alice",
	);
	let request = buildTargetingRequest(current, [], state.threads, extractQuotes(current.text));
	let target = request.questions.c0_thread as Extract<JevQuestion, { type: "choice" }>;
	expect(target.criteria["thread-a"]).toContain("Use an optional outline.");
	expect(target.criteria["thread-b"]).toContain("Add an optional sidebar.");
	let agreement = request.questions.c0_agrees_with_settle;
	expect(agreement?.instructions).toContain("If several proposals are pending");
	expect(agreement?.instructions).not.toContain("the pending proposal by bob");
});
