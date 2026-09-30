import { expect, test } from "bun:test";
import { replay } from "./domain";
import { runScopedAssent, runScopedProposal } from "./policy-candidate-scoped";
import { cardId, scopedFrame, scopedInput } from "./policy-candidate-scoped.test-fixtures";

test("a scoped proposal uses the linked card and cached spike label without choosing globally", () => {
	let input = scopedInput();
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role, spike } = scopedFrame(input);
	let before = structuredClone(input);
	expect(runScopedAssent(context, entry, role)).toBe(true);
	expect(runScopedProposal(context, entry, role, spike)).toBeUndefined();
	expect(context.events[0]!).toMatchObject({
		type: "scoped-choice.proposed",
		cardId,
		optionId: "alpha",
		label: "Alpha",
		scope: "spike",
	});
	expect(context.working.threads[0]!.pendingScopedChoice!.proposer).toBe("Mina");
	expect(context.working.threads[0]!.pendingSettle).toBeUndefined();
	expect(entry.outcome.status).toBe("accepted");
	expect(input).toEqual(before);
	expect(replay(context.working.events)).toEqual(context.working);
});

test("another member independently agrees with the exact scoped proposal", () => {
	let input = scopedInput(true);
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = scopedFrame(input);
	expect(runScopedAssent(context, entry, role)).toBeUndefined();
	expect(context.events[0]!).toMatchObject({
		type: "scoped-choice.agreed",
		proposalId: "scoped-proposal",
		cardId,
		optionId: "alpha",
		label: "Alpha",
		scope: "spike",
	});
	expect(entry.outcome.eventIds).toEqual([context.events[0]!.id]);
	expect(context.working.threads[0]!.pendingSettle).toBeUndefined();
	expect(replay(context.working.events)).toEqual(context.working);
});

test.each(["proposer", "wrong card", "duplicate label", "weak option", "weak chosen"])(
	"assent %s falls through",
	kind => {
		let input = scopedInput(true);
		if (kind === "proposer") input.message.author = { kind: "member", handle: "Jules" };
		if (kind === "wrong card") input.linkedCards!.get("provider")!.cardId = "other-card";
		if (kind === "duplicate label") {
			input.linkedCards = new Map([["provider", {
				cardId,
				options: [{ id: "alpha", label: "Alpha" }, { id: "alias", label: "Alpha" }],
			}]]);
		}
		if (kind === "weak option") {
			input.candidates[0]!.answers.option = {
				type: "choice",
				choice: "alpha",
				confidence: 0.95,
				probabilities: { alpha: 0.49, none: 0.51 },
			};
		}
		if (kind === "weak chosen") {
			input.candidates[0]!.answers.chosen_option = {
				type: "choice",
				choice: "alpha",
				confidence: 0.95,
				probabilities: { alpha: 0.59, none: 0.41 },
			};
		}
		let { context, entry, role } = scopedFrame(input);
		expect(runScopedAssent(context, entry, role)).toBe(true);
		expect(context.events).toHaveLength(0);
	},
);

test("assent accepts its raw option/chosen probabilities at their original bounds", () => {
	let input = scopedInput(true);
	input.candidates[0]!.answers.option = {
		type: "choice",
		choice: "alpha",
		confidence: 0.95,
		probabilities: { alpha: 0.5, none: 0.5 },
	};
	input.candidates[0]!.answers.chosen_option = {
		type: "choice",
		choice: "alpha",
		confidence: 0.95,
		probabilities: { alpha: 0.6, none: 0.4 },
	};
	let { context, entry, role } = scopedFrame(input);
	expect(role.option).toBeUndefined();
	expect(role.chosenOption).toBeUndefined();
	expect(runScopedAssent(context, entry, role)).toBeUndefined();
});

test("missing proposal lineage falls through even with a captured pending choice", () => {
	let { context, entry, role } = scopedFrame(scopedInput(true));
	context.working = {
		...context.working,
		events: context.working.events.filter(event => event.id !== "scoped-proposal"),
	};
	expect(runScopedAssent(context, entry, role)).toBe(true);
	expect(context.events).toHaveLength(0);
});

test("the duplicate proposal check retains the captured pending option and ignored status", () => {
	let input = scopedInput(true);
	input.message.text = "I'd pick Alpha for a spike;";
	input.candidates[0]!.quote = input.message.text;
	input.candidates[0]!.end = input.message.text.length;
	let { context, entry, role, spike } = scopedFrame(input);
	expect(runScopedProposal(context, entry, role, spike)).toBeUndefined();
	expect(entry.outcome.gate).toBe("spike choice already pending");
	expect(entry.outcome.status).toBe("ignored");
	expect(context.events).toHaveLength(0);
});

test("proposal uses the cached label rather than reparsing the valid quote", () => {
	let { context, entry, role, spike } = scopedFrame();
	spike.spikeLabel = "Beta";
	expect(runScopedProposal(context, entry, role, spike)).toBe(true);
	expect(context.events).toHaveLength(0);
});

test.each([{ assent: true, target: "events" }, { assent: false, target: "events" }, {
	assent: true,
	target: "IDs",
}, { assent: false, target: "IDs" }])(
	"$assent/$target push failure preserves applied scoped state",
	({ assent, target }) => {
		let { context, entry, role, spike } = scopedFrame(scopedInput(assent));
		if (target === "events") {
			context.events.push = () => {
				throw new Error("event push");
			};
		} else {entry.outcome.eventIds.push = () => {
				throw new Error("ID push");
			};}
		let result = assent
			? runScopedAssent(context, entry, role)
			: runScopedProposal(context, entry, role, spike);
		expect(result).toBeUndefined();
		expect(context.working.events.at(-1)!.type).toBe(
			assent ? "scoped-choice.agreed" : "scoped-choice.proposed",
		);
		expect(context.events).toHaveLength(target === "events" ? 0 : 1);
		expect(entry.outcome.status).toBe("review");
		expect(entry.outcome.gate).toBe(
			assent ? "scoped agreement needs review" : "scoped choice needs review",
		);
	},
);

test("a replacement input card map does not replace the earlier captured linked card", () => {
	let { context, entry, role, spike } = scopedFrame();
	let captured = role.linkedCard;
	context.input.linkedCards = new Map([["provider", { cardId: "replacement", options: [] }]]);
	expect(runScopedProposal(context, entry, role, spike)).toBeUndefined();
	expect(role.linkedCard).toBe(captured);
	expect(context.events[0]!).toMatchObject({ type: "scoped-choice.proposed", cardId });
});

test.each(["absent", "ambiguous"])("proposal requires one named linked-card label: %s", kind => {
	let input = scopedInput();
	input.linkedCards = new Map([["provider", {
		cardId,
		options: kind === "absent"
			? [{ id: "beta", label: "Beta" }]
			: [{ id: "alpha", label: "Alpha" }, { id: "alias", label: "Alpha" }],
	}]]);
	let { context, entry, role, spike } = scopedFrame(input);
	expect(runScopedProposal(context, entry, role, spike)).toBe(true);
	expect(context.events).toHaveLength(0);
});
