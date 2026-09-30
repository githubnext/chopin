import { expect, test } from "bun:test";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";
import { d01RobM7PolicyResult, d01SeedScopedChoiceProposal } from "./pipeline-scoped.test-fixtures";

test("D01 m7 independently agrees with Mei's pending Lexical spike choice", () => {
	let linked = d01LinkedEditorCard();
	let pending = d01SeedScopedChoiceProposal(linked);
	let { current, quotes, result } = d01RobM7PolicyResult(linked, { state: pending.state });
	expect(quotes).toEqual([
		{ quote: "yep, Lexical for the spike.", start: 0, end: 27 },
		{ quote: "not a final library call yet.", start: 28, end: 57 },
	]);
	let agreements = result.events.filter(event =>
		(event as { type: string }).type === "scoped-choice.agreed"
	);

	expect(agreements).toHaveLength(1);
	expect(agreements[0]).toMatchObject({
		type: "scoped-choice.agreed",
		id: expect.any(String),
		proposalId: pending.proposal.id,
		threadId: linked.threadId,
		cardId: "01M3QAQ8HM8DVYA9E4N28QCQ7T",
		optionId: pending.lexicalId,
		label: "Lexical",
		scope: "spike",
		source: {
			messageId: current.id,
			author: { kind: "member", handle: "Rob" },
			quote: quotes[0]!.quote,
			start: 0,
			end: 27,
			role: "support",
		},
	});
	expect(result.events.filter(event => event.type === "settle.agreed")).toEqual([]);
	expect(result.events.filter(event => event.type === "settle.suggested")).toEqual([]);
	expect(result.events.filter(event => event.type === "decision.recorded")).toEqual([]);
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
	expect(
		result.events.filter(event => (event as { type: string }).type === "card.answered"),
	).toEqual([]);
	expect(pending.state.threads[0]!.pendingScopedChoice).toMatchObject({
		proposalId: pending.proposal.id,
		cardId: "01M3QAQ8HM8DVYA9E4N28QCQ7T",
		optionId: pending.lexicalId,
		label: "Lexical",
		scope: "spike",
		proposer: "Mei",
		messageId: "d01-m6",
	});
	expect(pending.state.threads[0]!.pendingSettle).toBeUndefined();
	expect(pending.state.threads[0]!.decisionHistory).toEqual([]);
	expect(linked.state.threads[0]!.status).toBe("exploring");
	expect(linked.linkedCards.get(linked.threadId)?.options).toEqual(linked.options);
});

test("D01 m7 agreement binds the latest pending proposal ID", () => {
	let linked = d01LinkedEditorCard();
	let earlier = d01SeedScopedChoiceProposal(linked, "d01-m6-scoped-earlier");
	let current = d01SeedScopedChoiceProposal(
		{ ...linked, state: earlier.state },
		"d01-m6-scoped-current",
		"d01-m6-scoped-current-message",
	);
	let { result } = d01RobM7PolicyResult(linked, { state: current.state });
	let agreements = result.events.filter(event =>
		(event as { type: string }).type === "scoped-choice.agreed"
	);

	expect(agreements).toHaveLength(1);
	expect(agreements[0]).toMatchObject({ proposalId: current.proposal.id });
	expect(agreements[0]).not.toMatchObject({ proposalId: earlier.proposal.id });
});
