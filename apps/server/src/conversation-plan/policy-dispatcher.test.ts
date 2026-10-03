import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import {
	fallbackInput,
	multipleSupportInput,
	recoveryInput,
} from "./policy-dispatcher.test-fixtures";
import { supportInput } from "./policy-candidate-application.test-fixtures";
import { contributionInput } from "./policy-candidate-contribution.test-fixtures";
import { ordinaryInput } from "./policy-candidate-ordinary.test-fixtures";
import { reopeningInput, resolutionInput } from "./policy-candidate-resolution.test-fixtures";
import { newChoiceInput, scopedInput } from "./policy-candidate-scoped.test-fixtures";
import { stanceInput } from "./policy-candidate-stance.test-fixtures";
import { confidentChoice, inputFor } from "./policy-initial.test-fixtures";
import { replay } from "./domain";
import { d01RecordedOpening, declarativeInput } from "./policy-terminal.test-fixtures";
import { verificationInput } from "./policy-candidate-verification.test-fixtures";

// Complete pure dispatcher regressions; no runtime callers or original callback replacements.
test.each(
	[
		["reason", () => contributionInput(), "reason.added"],
		["option", () => contributionInput("option"), "option.added"],
		["constraint", () => contributionInput("constraint"), "constraint.added"],
		["support", () => supportInput([], true), "stance.changed"],
		["objection", () => stanceInput("objection"), "stance.changed"],
		["withdrawal", () => ordinaryInput(), "stance.changed"],
		["none", () => ordinaryInput("none"), "settle.agreed"],
		["question", () => ordinaryInput("question"), "thread.opened"],
		["resolution", () => resolutionInput(), "settle.suggested"],
		["reopening", () => reopeningInput(), "candidate.proposed"],
	] as const,
)("complete matching-role route %s applies %s", (_role, make, type) => {
	let input = make(), before = structuredClone(input);
	let result = planEvents(input);
	expect(result.events[0]!.type).toBe(type);
	expect(result.outcomes[0]!.status).toBe(type === "candidate.proposed" ? "review" : "accepted");
	expect(input).toEqual(before);
	expect(() => replay([...input.state.events, ...result.events])).not.toThrow();
});
test.each([[false, "scoped-choice.proposed"], [true, "scoped-choice.agreed"]] as const)(
	"scoped path %s handles before ordinary application",
	(assent, type) => {
		let input = scopedInput(assent), result = planEvents(input);
		expect(result.events.map(item => item.type)).toEqual([type]);
		expect(result.outcomes[0]!.status).toBe("accepted");
	},
);
test("direct new choice handles before ordinary role proposals", () => {
	let result = planEvents(newChoiceInput());
	expect(result.events.map(item => item.type)).toEqual(["option.added", "settle.suggested"]);
});
test("fallback opens from the later owned candidate without changing index-zero IDs", () => {
	let result = planEvents(fallbackInput());
	expect(result.events.map(item => item.type)).toEqual(["thread.opened"]);
	expect(result.outcomes[0]!.status).toBe("ignored");
	expect(result.outcomes[1]!.status).toBe("accepted");
	expect(Object.hasOwn(result, "selectedTarget")).toBe(true);
});
test("truthy unrecognized role produces no proposal without throwing", () => {
	let input = contributionInput();
	input.candidates[0]!.answers.role = confidentChoice("toString");
	let result = planEvents(input);
	expect(result.events).toEqual([]);
	expect(result.outcomes).toHaveLength(1);
});
test("ineligible terminal result omits the ordinary selectedTarget property", () => {
	let input = inputFor("Alpha or Beta?");
	input.message.streaming = true;
	let result = planEvents(input);
	expect(result.policyGate).toBe("ineligible message");
	expect(Object.hasOwn(result, "selectedTarget")).toBe(false);
});
test("quote budget still precedes eligibility", () => {
	let input = inputFor("Hi");
	input.message.streaming = true;
	input.candidates = Array.from({ length: 13 }, () => input.candidates[0]!);
	expect(() => planEvents(input)).toThrow();
});
test("candidate source skip preserves later processing and captured candidate order", () => {
	let input = contributionInput();
	input.candidates = [{ ...input.candidates[0]!, quote: "wrong source" }, input.candidates[0]!];
	input.first.c1_owned_unretracted = { type: "noul", noul: 0.95 };
	let result = planEvents(input);
	expect(result.outcomes).toHaveLength(2);
	expect(result.outcomes[0]!.eventIds).toEqual([]);
	expect(result.outcomes[1]!.status).toBe("accepted");
	expect(result.events.map(item => item.type)).toEqual(["reason.added"]);
});

test("multiple support candidates preserve order and share the first leaning transition", () => {
	let input = multipleSupportInput();
	expect(input.candidates).toHaveLength(4);
	let result = planEvents(input);
	expect(result.events).toHaveLength(5);
	expect(result.outcomes).toHaveLength(4);
	expect(result.events[1]!.type).toBe("thread.leaning");
	expect(result.outcomes.every(item => item.status === "accepted")).toBe(true);
	expect(() => replay([...input.state.events, ...result.events])).not.toThrow();
});

test.each(
	[
		[
			"owned compound",
			() => inputFor("We need to choose how people sign in and how agents get credentials."),
			"explicit compound questions accepted",
		],
		[
			"attributed compound",
			() =>
				inputFor("Alice said we need to choose how people sign in and how agents get credentials."),
			"compound decision attribution unclear",
		],
		["recovery", recoveryInput, "direct options recovered"],
		[
			"direct alternatives",
			() => inputFor("Should audit logs go in PostgreSQL or object storage?"),
			"direct alternatives accepted",
		],
		["declarative pair", declarativeInput, "declarative options accepted"],
		["purpose and question", d01RecordedOpening, "owned purpose and final question accepted"],
	] as const,
)("complete terminal path %s retains %s", (_name, make, gate) => {
	let input = make(), before = structuredClone(input), result = planEvents(input);
	expect(result.policyGate).toBe(gate);
	expect(input).toEqual(before);
	expect(() => replay([...input.state.events, ...result.events])).not.toThrow();
});

test("verified deferred proposal resumes before later scoped and ordinary handlers", () => {
	let input = verificationInput(), before = structuredClone(input), result = planEvents(input);
	expect(result.events.map(item => item.type)).toEqual(["settle.resumed"]);
	expect(result.outcomes[0]!.status).toBe("accepted");
	expect(input).toEqual(before);
	expect(() => replay([...input.state.events, ...result.events])).not.toThrow();
});
