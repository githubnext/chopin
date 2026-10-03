import { activeScopedSupport, currentScopedProposal } from "./events";
import { expect, test } from "bun:test";
import { applyInference, replay } from "./domain";
import {
	rawChoice,
	scopedStanceInput,
	stanceFrame,
	withdrawScopedAgreement,
} from "./policy-candidate-stance.test-fixtures";
import { runStance } from "./policy-candidate-stance";

test.each([{ participant: "Jules", agreed: false, expected: "scoped-proposal" }, {
	participant: "Mina",
	agreed: true,
	expected: "scoped-proposal",
}, { participant: "Cora", agreed: false, expected: null }])(
	"scoped objection ownership: $participant/$agreed",
	({ participant, agreed, expected }) => {
		let input = scopedStanceInput(participant, agreed);
		expect(replay(input.state.events)).toEqual(input.state);
		let { context, entry, role } = stanceFrame(input);
		let event = runStance(context, entry, role)!.proposed!;
		expect(event).toMatchObject({
			type: "stance.changed",
			position: "oppose",
			optionId: "alpha",
			scopedProposalId: expected,
		});
		let accepted = applyInference(input.state, event, input.message);
		expect(replay(accepted.events)).toEqual(accepted);
		expect(context.events).toHaveLength(0);
	},
);
test("support leaves scopedProposalId null even for the scoped proposer", () => {
	let { context, entry, role } = stanceFrame(scopedStanceInput("Jules", false, "support"));
	expect(runStance(context, entry, role)!.proposed).toMatchObject({
		position: "support",
		scopedProposalId: null,
	});
});
test.each(["proposal", "agreement"])(
	"current history must retain the exact %s for scoped ownership",
	removed => {
		let { context, entry, role } = stanceFrame(scopedStanceInput("Mina", true));
		let captured = role.thread;
		context.working = {
			...context.working,
			events: context.working.events.filter(event =>
				removed === "proposal" ? event.id !== "scoped-proposal" : event.id !== "scoped-assent"
			),
		};
		expect(runStance(context, entry, role)!.proposed).toMatchObject({ scopedProposalId: null });
		expect(role.thread).toBe(captured);
	},
);
test.each(["option", "chosen_option"])(
	"scoped ownership requires confident %s despite raw fallback",
	answer => {
		let input = scopedStanceInput();
		input.candidates[0]!.answers[answer] = rawChoice("alpha");
		let { context, entry, role } = stanceFrame(input);
		expect(runStance(context, entry, role)!.proposed).toMatchObject({
			optionId: "alpha",
			scopedProposalId: null,
		});
	},
);
test("restoring a fresh card map cannot replace a mismatched captured scoped card", () => {
	let input = scopedStanceInput();
	let card = input.linkedCards!.get("provider")!;
	input.linkedCards = new Map([["provider", { ...card, cardId: "stale" }]]);
	let { context, entry, role } = stanceFrame(input);
	context.input.linkedCards = new Map([["provider", card]]);
	expect(role.linkedCard!.cardId).toBe("stale");
	expect(runStance(context, entry, role)!.proposed).toMatchObject({ scopedProposalId: null });
});

test("historical agreement still establishes ownership after active support withdrawal", () => {
	let input = scopedStanceInput("Mina", true);
	withdrawScopedAgreement(input);
	expect(replay(input.state.events)).toEqual(input.state);
	let proposal = currentScopedProposal(input.state.threads[0]!, input.state.events)!;
	expect(
		activeScopedSupport(input.state.events, proposal).some(event =>
			event.source.author.kind === "member" && event.source.author.handle === "Mina"
		),
	).toBe(false);
	let { context, entry, role } = stanceFrame(input);
	expect(runStance(context, entry, role)!.proposed).toMatchObject({
		scopedProposalId: "scoped-proposal",
	});
});
