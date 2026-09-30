import { expect, test } from "bun:test";
import {
	ordinaryFrame,
	ordinaryInput,
	withdrawCurrent,
} from "./policy-candidate-ordinary.test-fixtures";
import { runAgreement } from "./policy-candidate-agreement";

test.each([0.7, 0.699])(
	"agreement threshold %s returns progression even without a proposal",
	probability => {
		let input = ordinaryInput("none");
		input.candidates[0]!.answers.agrees_with_settle = { type: "noul", noul: probability };
		let { context, entry, role } = ordinaryFrame(input);
		expect(role.role).toBe("none");
		let result = runAgreement(context, entry, role);
		expect(result).toBeDefined();
		if (probability === 0.7) {
			expect(result?.proposed).toMatchObject({ type: "settle.agreed", optionId: "alpha" });
			expect(context.selectedTarget).toBe("provider");
			expect(entry.outcome.targetId).toBe("provider");
		} else {
			expect(result?.proposed).toBeUndefined();
			expect(context.selectedTarget).toBeUndefined();
		}
		expect(context.events).toHaveLength(0);
	},
);
test("agreement recomputes effective pending from current working", () => {
	let input = ordinaryInput("none");
	let { context, entry, role } = ordinaryFrame(input);
	context.working = withdrawCurrent(input);
	expect(role.pending).toBeDefined();
	expect(runAgreement(context, entry, role)).toEqual({ proposed: undefined });
	expect(context.selectedTarget).toBeUndefined();
});
test("agreement retains the raw named option despite low classifier confidence", () => {
	let input = ordinaryInput("none");
	input.candidates[0]!.answers.option = {
		type: "choice",
		choice: "beta",
		confidence: 0.4,
		probabilities: { beta: 0.4, alpha: 0.35, none: 0.25 },
	};
	let { context, entry, role } = ordinaryFrame(input);
	expect(role.option).toBeUndefined();
	expect(runAgreement(context, entry, role)).toEqual({ proposed: undefined });
});
test.each(["base", "source"])("%s failure precedes selected-target assignment", failure => {
	let { context, entry, role } = ordinaryFrame(ordinaryInput("none"));
	let before = structuredClone(entry.outcome);
	if (failure === "base") {
		context.working.threads.find = () => {
			throw new Error("base read");
		};
	} else {Object.defineProperty(entry.candidate, "quote", {
			get() {
				throw new Error("source read");
			},
		});}
	expect(() => runAgreement(context, entry, role)).toThrow(failure + " read");
	expect(context.selectedTarget).toBeUndefined();
	expect(entry.outcome).toEqual(before);
});
