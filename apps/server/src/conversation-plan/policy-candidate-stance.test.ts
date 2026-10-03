import { expect, test } from "bun:test";
import { applyInference, replay } from "./domain";
import {
	confidentChoice,
	decidedInput,
	rawChoice,
	stanceFrame,
	stanceInput,
} from "./policy-candidate-stance.test-fixtures";
import { runStance } from "./policy-candidate-stance";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import { linkContributionCard } from "./policy-candidate-contribution.test-fixtures";
import { stableId } from "./policy-identity";

test.each(["support", "objection"])(
	"%s returns the exact regular stance without applying it",
	name => {
		let input = stanceInput(name);
		expect(replay(input.state.events)).toEqual(input.state);
		let { context, entry, role } = stanceFrame(input);
		expect(role.role).toBe(name);
		let before = structuredClone(context.working);
		let event = runStance(context, entry, role)!.proposed!;
		expect(event).toMatchObject({
			type: "stance.changed",
			source: { role: name, quote: input.message.text },
			position: name === "support" ? "support" : "oppose",
			optionId: "alpha",
			scopedProposalId: null,
		});
		let accepted = applyInference(input.state, event, input.message);
		expect(replay(accepted.events)).toEqual(accepted);
		expect(context.working).toEqual(before);
		expect(context.events).toHaveLength(0);
		expect(context.reviews).toHaveLength(0);
		expect(entry.outcome.eventIds).toHaveLength(0);
	},
);
test.each([0.679, 0.68])("decided material objection threshold %s", probability => {
	let input = decidedInput(probability);
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = stanceFrame(input);
	let event = runStance(context, entry, role)!.proposed!;
	if (probability === 0.68) {
		expect(event).toMatchObject({
			type: "candidate.proposed",
			source: { role: "reopening" },
			candidate: {
				id: stableId(input.channelId, input.message.id, 0, "reopening-candidate"),
				kind: "reopening",
				text: input.message.text,
			},
		});
		expect(context.reviews).toHaveLength(1);
	} else {
		expect(event.type).toBe("stance.changed");
		expect(context.reviews).toHaveLength(0);
	}
	expect(context.events).toHaveLength(0);
});
test("a second reopening review is handled before constructing a proposal", () => {
	let { context, entry, role } = stanceFrame(decidedInput());
	context.reviews.push({ id: "existing", kind: "reopening", targetId: "provider" });
	expect(runStance(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("reopening review already proposed from this message");
	expect(context.reviews).toHaveLength(1);
});
test("missing captured thread is handled without a stance", () => {
	let input = stanceInput();
	input.candidates[0]!.answers.thread = confidentChoice("missing");
	let { context, entry, role } = stanceFrame(input);
	expect(runStance(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("stance target or human authority unclear");
});
test("late agent author fails the original human guard", () => {
	let { context, entry, role } = stanceFrame();
	context.message.author = { kind: "agent" };
	expect(runStance(context, entry, role)).toBeUndefined();
	expect(entry.outcome.status).toBe("review");
});
test.each(["wrong-card", "substring", "duplicate-name", "wrong-text", "wrong-target", "unnamed"])(
	"captured card boundary: %s",
	variant => {
		let input = stanceInput();
		let card = input.linkedCards!.get("provider")!;
		if (variant === "wrong-card") {
			input.linkedCards = new Map([["provider", {
				...card,
				cardId: "wrong",
			}]]);
		}
		if (variant === "substring" || variant === "duplicate-name") {
			input.linkedCards = new Map([["provider", {
				...card,
				options: [...card.options, {
					id: "other",
					label: variant === "substring" ? "Alpha Pro" : "Alpha",
				}],
			}]]);
		}
		if (variant === "wrong-text") {
			input.linkedCards = new Map([["provider", {
				...card,
				options: [{ id: "alpha", label: "Beta" }],
			}]]);
			input.message.text = "I support Beta.";
			Object.assign(input.candidates[0]!, {
				quote: input.message.text,
				end: input.message.text.length,
			});
		}
		if (variant === "wrong-target") input.first.thread_target = confidentChoice("other");
		if (variant === "unnamed") {
			input.message.text = "I agree.";
			Object.assign(input.candidates[0]!, {
				quote: input.message.text,
				end: input.message.text.length,
			});
		}
		let { context, entry, role } = stanceFrame(input);
		let event = runStance(context, entry, role)!.proposed!;
		expect(event).toMatchObject({
			type: "stance.changed",
			optionId: undefined,
			scopedProposalId: null,
		});
		expect(Object.hasOwn(event, "optionId")).toBe(true);
	},
);
test.each(["alpha", "beta"])("raw option fallback preserves %s despite low confidence", option => {
	let input = stanceInput();
	input.candidates[0]!.answers.option = rawChoice(option);
	input.candidates[0]!.answers.chosen_option = rawChoice("alpha");
	let { context, entry, role } = stanceFrame(input);
	expect(role.option).toBeUndefined();
	expect(role.chosenOption).toBeUndefined();
	let event = runStance(context, entry, role)!.proposed!;
	expect(event).toMatchObject({ optionId: option === "alpha" ? "alpha" : undefined });
});
test("captured chosen-option mismatch clears a named option", () => {
	let input = stanceInput();
	input.candidates[0]!.answers.chosen_option = confidentChoice("beta");
	let { context, entry, role } = stanceFrame(input);
	expect(runStance(context, entry, role)!.proposed).toMatchObject({ optionId: undefined });
});
test("fresh input card replacement does not replace the earlier captured card", () => {
	let { context, entry, role } = stanceFrame();
	let card = role.linkedCard;
	context.input.linkedCards = new Map();
	expect(runStance(context, entry, role)!.proposed).toMatchObject({ optionId: "alpha" });
	expect(role.linkedCard).toBe(card);
});

test("reverse substring collision rejects one indirectly named card label", () => {
	let label = "Start with a durable queue.";
	let input = stanceInput("support", "I support a durable queue.");
	input.state = stateWithOption("Which provider?", "provider", "alpha", label);
	linkContributionCard(input);
	let card = input.linkedCards!.get("provider")!;
	input.linkedCards = new Map([["provider", {
		...card,
		options: [{ id: "alpha", label }, { id: "other", label: "Start with a durable" }],
	}]]);
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = stanceFrame(input);
	expect(runStance(context, entry, role)!.proposed).toMatchObject({ optionId: undefined });
});
test("raw chosen-option conflict blocks fallback independently of raw option", () => {
	let input = stanceInput();
	input.candidates[0]!.answers.option = rawChoice("alpha");
	input.candidates[0]!.answers.chosen_option = rawChoice("beta");
	let { context, entry, role } = stanceFrame(input);
	expect(role.chosenOption).toBeUndefined();
	expect(runStance(context, entry, role)!.proposed).toMatchObject({ optionId: undefined });
});
