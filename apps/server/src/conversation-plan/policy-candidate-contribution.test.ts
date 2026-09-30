import { expect, test } from "bun:test";
import { applyInference, replay } from "./domain";
import {
	contributionFrame,
	contributionInput,
	linkContributionCard,
	qualifiedInput,
} from "./policy-candidate-contribution.test-fixtures";
import { runContribution } from "./policy-candidate-contribution";
import { confidentChoice } from "./policy-initial.test-fixtures";
import { withdrawCurrent } from "./policy-candidate-ordinary.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import { optionIdFor, stableId } from "./policy-identity";

test.each(["option", "reason", "constraint"])(
	"%s preserves exact quoted proposal without application",
	roleName => {
		let input = contributionInput(roleName);
		expect(replay(input.state.events)).toEqual(input.state);
		let { context, entry, role } = contributionFrame(input);
		let before = structuredClone(context.working);
		expect(role.role).toBe(roleName);
		let result = runContribution(context, entry, role);
		expect(result?.proposed).toMatchObject({
			type: roleName + ".added",
			source: { quote: entry.candidate.quote, role: roleName },
			contribution: {
				text: entry.candidate.quote,
				authoring: "quoted",
				targetId: "alpha",
				relation: "supports",
			},
		});
		let proposed = result!.proposed!;
		expect("contribution" in proposed && proposed.contribution.id).toBe(
			roleName === "option"
				? optionIdFor(input.channelId, input.message.id, 0, input.message.ts)
				: stableId(input.channelId, input.message.id, 0, "contribution"),
		);
		let accepted = applyInference(input.state, proposed, input.message);
		expect(replay(accepted.events)).toEqual(accepted);
		expect(context.working).toEqual(before);
		expect(context.events).toHaveLength(0);
		expect(context.reviews).toHaveLength(0);
		expect(entry.outcome.eventIds).toHaveLength(0);
	},
);
test.each([
	"Alpha, Beta, or Gamma",
	"Which provider fits?",
	"Alpha is quick but Beta is flexible.",
])("unsafe option quote stays usable as a reason/constraint: %s", quote => {
	for (let name of ["option", "reason", "constraint"]) {
		let { context, entry, role } = contributionFrame(contributionInput(name, quote));
		let result = runContribution(context, entry, role);
		if (name === "option") {
			expect(result).toBeUndefined();
			expect(entry.outcome.status).toBe("review");
			expect(entry.outcome.gate).toBe(
				"option source contains a question, group, or contrastive evaluation",
			);
		} else {
			let expected: "reason.added" | "constraint.added" = name === "reason"
				? "reason.added"
				: "constraint.added";
			expect(result?.proposed?.type).toBe(expected);
		}
	}
});
test.each([0.799, 0.8])(
	"duplicate threshold %s preserves ignored outcome on refusal",
	probability => {
		let input = contributionInput();
		input.candidates[0]!.answers.duplicate = { type: "noul", noul: probability };
		let { context, entry, role } = contributionFrame(input);
		let result = runContribution(context, entry, role);
		if (probability === 0.8) {
			expect(result).toBeUndefined();
			expect(entry.outcome.gate).toBe("duplicate contribution");
			expect(entry.outcome.status).toBe("ignored");
		} else expect(result?.proposed?.type).toBe("reason.added");
	},
);
test("cached option group exempts the duplicate guard", () => {
	let { context, entry, role } = contributionFrame();
	entry.candidate.answers.duplicate = { type: "noul", noul: 1 };
	context.candidateRun!.optionGroup = "provider";
	expect(runContribution(context, entry, role)?.proposed?.type).toBe("reason.added");
	expect(context.events).toHaveLength(0);
});
test("missing captured thread is handled without inventing an event", () => {
	let input = contributionInput();
	input.candidates[0]!.answers.thread = confidentChoice("missing");
	let { context, entry, role } = contributionFrame(input);
	expect(role.thread).toBeUndefined();
	expect(runContribution(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("contribution target needs review");
	expect(context.events).toHaveLength(0);
});
test.each(["matching", "wrong-card", "ambiguous"])(
	"existing option name/card uniqueness: %s",
	variant => {
		let input = contributionInput("option", "I'd pick Alpha.");
		linkContributionCard(input);
		if (variant === "wrong-card") input.linkedCards!.get("provider")!.cardId = "replacement";
		if (variant === "ambiguous") {
			let card = input.linkedCards!.get("provider")!;
			input.linkedCards = new Map([["provider", {
				...card,
				options: [...card.options, { id: "other", label: "Alpha" }],
			}]]);
		}
		expect(replay(input.state.events)).toEqual(input.state);
		let { context, entry, role } = contributionFrame(input);
		let result = runContribution(context, entry, role);
		if (variant === "matching") {
			expect(result).toBeUndefined();
			expect(entry.outcome.gate).toBe("proposal names an existing card option");
		} else expect(result?.proposed?.type).toBe("option.added");
	},
);
test("fresh card map replacement overrides the earlier captured linked card", () => {
	let input = contributionInput("option", "I'd pick Alpha.");
	linkContributionCard(input);
	let { context, entry, role } = contributionFrame(input);
	let captured = role.linkedCard;
	context.input.linkedCards = new Map([["provider", { cardId: "replacement", options: [] }]]);
	expect(runContribution(context, entry, role)?.proposed?.type).toBe("option.added");
	expect(role.linkedCard).toBe(captured);
});
test("freshly restored matching card is read after an earlier mismatched capture", () => {
	let input = contributionInput("option", "I'd pick Alpha.");
	linkContributionCard(input);
	let saved = input.linkedCards!.get("provider")!;
	input.linkedCards = new Map([["provider", { ...saved, cardId: "stale" }]]);
	let { context, entry, role } = contributionFrame(input);
	context.input.linkedCards = new Map([["provider", saved]]);
	expect(role.linkedCard!.cardId).toBe("stale");
	expect(runContribution(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("proposal names an existing card option");
});
test.each(["alpha", "missing", "none"])(
	"target option %s uses captured contributions or thread fallback",
	option => {
		let input = contributionInput();
		input.candidates[0]!.answers.option = confidentChoice(option);
		let { context, entry, role } = contributionFrame(input);
		let event = runContribution(context, entry, role)!.proposed!;
		expect("contribution" in event && event.contribution.targetId).toBe(
			option === "alpha" ? "alpha" : "provider",
		);
	},
);
test.each(["supports", "challenges", "qualifies", "blocks"])("relation allowlist: %s", relation => {
	let input = contributionInput();
	input.candidates[0]!.answers.relation = confidentChoice(relation);
	let { context, entry, role } = contributionFrame(input);
	let event = runContribution(context, entry, role)!.proposed!;
	expect("contribution" in event && event.contribution.relation).toBe(
		relation === "blocks" ? undefined : relation,
	);
	if (relation === "blocks") {
		expect("contribution" in event && Object.hasOwn(event.contribution, "relation")).toBe(false);
	}
});
test("qualified pending forces its captured option and relation despite later answers", () => {
	let input = qualifiedInput();
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = contributionFrame(input);
	expect(role.qualifiedPending).toBeTruthy();
	context.working = withdrawCurrent(input);
	expect(replay(context.working.events)).toEqual(context.working);
	entry.candidate.answers.option = confidentChoice("missing");
	entry.candidate.answers.relation = confidentChoice("challenges");
	let event = runContribution(context, entry, role)!.proposed!;
	expect("contribution" in event && event.contribution).toMatchObject({
		targetId: "alpha",
		relation: "qualifies",
	});
});
test.each(["base", "source", "text"])("%s failure does not assign a proposal outcome", failure => {
	let { context, entry, role } = contributionFrame();
	let before = structuredClone(entry.outcome);
	let reads = 0;
	if (failure === "base") {
		context.working.threads.find = () => {
			throw new Error("base read");
		};
	} else {
		let quote = entry.candidate.quote;
		Object.defineProperty(entry.candidate, "quote", {
			get() {
				if (++reads === (failure === "source" ? 1 : 2)) throw new Error(failure + " read");
				return quote;
			},
		});
	}
	if (failure !== "base") expect(reads).toBe(0);
	expect(() => runContribution(context, entry, role)).toThrow(failure + " read");
	expect(entry.outcome).toEqual(before);
	expect(context.events).toHaveLength(0);
	if (failure !== "base") expect(reads).toBe(failure === "source" ? 1 : 2);
});

test("target selection keeps captured contributions after working-thread replacement", () => {
	let { context, entry, role } = contributionFrame();
	let captured = role.thread;
	context.working = stateWithOption("Which provider?", "provider", "beta", "Beta");
	expect(replay(context.working.events)).toEqual(context.working);
	let event = runContribution(context, entry, role)!.proposed!;
	expect("contribution" in event && event.contribution.targetId).toBe("alpha");
	expect(role.thread).toBe(captured);
	expect(context.working.threads[0]!.contributions[0]!.id).toBe("beta");
});
