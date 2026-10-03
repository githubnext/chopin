import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";
import { d01RobM7PolicyResult, d01SeedScopedChoiceProposal } from "./pipeline-scoped.test-fixtures";

test("D01 m7 cannot agree from quoted, self, mismatched, or unpending evidence", () => {
	let linked = d01LinkedEditorCard();
	let pending = d01SeedScopedChoiceProposal(linked);
	let cases: Array<{
		name: string;
		state: ConversationPlan.State;
		owned?: number;
		author?: string;
		text?: string;
		optionId?: string;
	}> = [
		{
			name: "low ownership",
			state: pending.state,
			owned: 0.2,
		},
		{
			name: "quoted affirmation",
			state: pending.state,
			text: 'Nia said: "yep, Lexical for the spike."',
			owned: 0.89,
		},
		{
			name: "the proposer repeats their own preference",
			state: pending.state,
			author: "Mei",
		},
		{
			name: "another option is named",
			state: pending.state,
			text: "yep, Tiptap for the spike. not a final library call yet.",
			optionId: linked.options[0]!.id,
		},
		{
			name: "another scope is named",
			state: pending.state,
			text: "yep, Lexical for the final call. not a final library call yet.",
		},
		{
			name: "there is no pending proposal",
			state: linked.state,
		},
	];

	for (let [index, item] of cases.entries()) {
		let { result } = d01RobM7PolicyResult(linked, {
			state: item.state,
			owned: item.owned,
			author: item.author,
			text: item.text,
			optionId: item.optionId,
			messageId: `d01-m7-negative-${index}`,
		});
		expect(
			result.events.filter(event => (event as { type: string }).type === "scoped-choice.agreed"),
		).toEqual([]);
		expect(result.events.filter(event => event.type === "settle.agreed")).toEqual([]);
		expect(result.events.filter(event => event.type === "decision.recorded")).toEqual([]);
	}
});
