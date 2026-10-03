import { expect, test } from "bun:test";
import { applyInference } from "./domain";
import { applyEvent } from "./events";
import { planEvents } from "./policy";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";
import { d01RobM7PolicyResult, d01SeedScopedChoiceProposal } from "./pipeline-scoped.test-fixtures";

test("a new stance links scoped support only with a confident owned target", () => {
	let linked = d01LinkedEditorCard();
	let pending = d01SeedScopedChoiceProposal(linked);
	let withNamedOption = applyEvent(pending.state, {
		id: "scoped-stance-named-option",
		type: "option.added",
		threadId: linked.threadId,
		observedThreadVersion: pending.state.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Mei" },
		at: 1002,
		contribution: { id: pending.lexicalId, text: "Lexical", authoring: "human-edited" },
	});
	let accepted = d01RobM7PolicyResult(linked, { state: pending.state });
	let agreement = accepted.result.events.find(event => event.type === "scoped-choice.agreed");
	if (!agreement) throw new Error("scoped agreement missing");
	let withAgreement = applyInference(pending.state, agreement, accepted.current);
	let cases = [
		{
			name: "proposer with exact target",
			state: pending.state,
			speaker: "Mei",
			quote: "I oppose Lexical for the spike.",
			option: pending.lexicalId,
			expected: pending.proposal.id,
		},
		{
			name: "proposer with exact named option",
			state: withNamedOption,
			speaker: "Mei",
			quote: "I oppose Lexical for the spike.",
			option: pending.lexicalId,
			chosenOption: pending.lexicalId,
			expectedOptionId: pending.lexicalId,
			expected: pending.proposal.id,
		},
		{
			name: "proposer with mismatched chosen option",
			state: withNamedOption,
			speaker: "Mei",
			quote: "I oppose Lexical for the spike.",
			option: pending.lexicalId,
			chosenOption: "none",
			expectedOptionId: pending.lexicalId,
			expected: null,
		},
		{
			name: "agreeing supporter with exact target",
			state: withAgreement,
			speaker: "Rob",
			quote: "I oppose Lexical for the spike.",
			option: pending.lexicalId,
			expected: pending.proposal.id,
		},
		{
			name: "non-supporter with exact target",
			state: pending.state,
			speaker: "Nia",
			quote: "I oppose Lexical for the spike.",
			option: pending.lexicalId,
			expected: null,
		},
		{
			name: "proposer with unrelated objection",
			state: pending.state,
			speaker: "Mei",
			quote: "I oppose making the toolbar blue.",
			option: "none",
			expected: null,
		},
	];
	for (let [index, item] of cases.entries()) {
		let current = message(`scoped-stance-${index}`, item.quote, item.speaker);
		let result = planEvents({
			channelId: "channel",
			message: current,
			state: item.state,
			linkedCards: linked.linkedCards,
			first: {
				...first({ c0_owned_unretracted: 0.98 }),
				act: confidentChoice("evaluation"),
				thread_target: confidentChoice(linked.threadId),
			},
			candidates: [{
				quote: item.quote,
				start: 0,
				end: item.quote.length,
				answers: {
					...follow({ role: "objection", thread: linked.threadId }),
					option: confidentChoice(item.option),
					chosen_option: confidentChoice(item.chosenOption ?? item.option),
				},
			}],
		});
		let stances = result.events.filter(event => event.type === "stance.changed");
		expect(stances, item.name).toHaveLength(1);
		expect(stances[0], item.name).toMatchObject({
			type: "stance.changed",
			optionId: item.expectedOptionId,
			scopedProposalId: item.expected,
		});
	}
});
