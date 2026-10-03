import { expect, test } from "bun:test";
import { finishPolicy } from "./policy-final";
import { finalContext } from "./policy-dispatcher.test-fixtures";
import { stableId } from "./policy-identity";
import { inputFor } from "./policy-initial.test-fixtures";

test("final fallback owns candidate one but uses index-zero identity and the full message", () => {
	let context = finalContext(), before = context.working;
	let result = finishPolicy(context);
	expect(result.events).toHaveLength(1);
	expect(result.events[0]).toMatchObject({
		id: stableId(context.channelId, context.message.id, 0, "thread.opened"),
		question: context.message.text,
		source: { quote: context.message.text, start: 0, end: context.message.text.length },
	});
	expect(result.outcomes[0]!.eventIds).toEqual([]);
	expect(result.outcomes[1]!.eventIds).toEqual([result.events[0]!.id]);
	expect(result.outcomes[1]!.status).toBe("accepted");
	expect(context.working).toBe(before);
	expect(context.working.threads).toHaveLength(0);
	expect(Object.hasOwn(result, "selectedTarget")).toBe(true);
	expect(result.selectedTarget).toBeUndefined();
});
test("fallback reads live owned scores and role answers", () => {
	let context = finalContext();
	context.first.c1_owned_unretracted = { type: "noul", noul: 0.69 };
	expect(finishPolicy(context).events).toEqual([]);
	context.first.c1_owned_unretracted = { type: "noul", noul: 0.7 };
	context.input.candidates[1]!.answers.role = {
		type: "choice",
		choice: "none",
		confidence: 1,
		probabilities: { none: 1 },
	};
	expect(finishPolicy(context).events).toEqual([]);
});
test("final gate truncates at exactly three hundred characters", () => {
	let context = finalContext();
	context.directQuestion = false;
	context.outcomes[0]!.gate = "x".repeat(299);
	context.outcomes[1]!.gate = "later";
	let result = finishPolicy(context);
	expect(result.policyGate).toBe(("0:" + "x".repeat(299) + "; 1:later").slice(0, 300));
	expect(result.policyGate).toHaveLength(300);
});
test("final empty result preserves selectedTarget property presence", () => {
	let input = inputFor("No source candidates.");
	input.candidates = [];
	let context = finalContext(input);
	context.directQuestion = false;
	let result = finishPolicy(context);
	expect(result).toEqual({
		events: [],
		selectedTarget: undefined,
		candidates: [],
		outcomes: [],
		policyGate: "no source candidates",
	});
	expect(Object.hasOwn(result, "selectedTarget")).toBe(true);
});
