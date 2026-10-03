import { expect, test } from "bun:test";
import { replay } from "./domain";
import {
	ordinaryFrame,
	ordinaryInput,
	withdrawCurrent,
} from "./policy-candidate-ordinary.test-fixtures";
import { runWithdrawal } from "./policy-candidate-withdrawal";

test.each([0.8, 0.799])("withdrawal threshold %s retains a valid owned proposal", probability => {
	let input = ordinaryInput();
	input.candidates[0]!.answers.withdraws_pending_settle = { type: "noul", noul: probability };
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = ordinaryFrame(input);
	expect(role.role).toBe("withdrawal");
	let before = structuredClone(context.working);
	let result = runWithdrawal(context, entry, role);
	if (probability === 0.8) {
		expect(result?.proposed).toMatchObject({
			type: "stance.changed",
			optionId: "alpha",
			position: "neutral",
			source: { role: "withdrawal" },
		});
	} else {
		expect(result).toBeUndefined();
		expect(entry.outcome.gate).toBe("pending withdrawal needs a clear owned proposal");
	}
	expect(context.working).toEqual(before);
	expect(context.events).toHaveLength(0);
});
test.each(["If I withdraw that choice.", "I withdraw that choice?"])(
	"conditional/question withdrawal is handled: %s",
	quote => {
		let input = ordinaryInput();
		input.message.text = quote;
		Object.assign(input.candidates[0]!, { quote, end: quote.length });
		let { context, entry, role } = ordinaryFrame(input);
		expect(runWithdrawal(context, entry, role)).toBeUndefined();
		expect(entry.outcome.status).toBe("review");
	},
);
test("withdrawal keeps captured pending/thread while searching current event history", () => {
	let input = ordinaryInput();
	let { context, entry, role } = ordinaryFrame(input);
	context.working = withdrawCurrent(input);
	expect(replay(context.working.events)).toEqual(context.working);
	expect(role.pending).toBeDefined();
	expect(runWithdrawal(context, entry, role)?.proposed?.type).toBe("stance.changed");
});
test("missing current authored proposal rejects the previously captured pending", () => {
	let { context, entry, role } = ordinaryFrame();
	context.working = {
		...context.working,
		events: context.working.events.filter(event => event.type !== "settle.suggested"),
	};
	expect(runWithdrawal(context, entry, role)).toBeUndefined();
	expect(entry.outcome.status).toBe("review");
});

test("another member cannot withdraw the captured owned proposal", () => {
	let input = ordinaryInput();
	input.message.author = { kind: "member", handle: "Mina" };
	let { context, entry, role } = ordinaryFrame(input);
	expect(runWithdrawal(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("pending withdrawal needs a clear owned proposal");
	expect(context.events).toHaveLength(0);
});
