import { expect, test } from "bun:test";

import { JevBudget } from "./planner-visual-jev-budget";

test("reserves no more than three Jev dispatches for one frozen case", () => {
	let budget = new JevBudget(["R1", "E1", "D1"]);
	expect(budget.reserve("R1")).toEqual({ caseCount: 1, total: 1 });
	expect(budget.reserve("R1")).toEqual({ caseCount: 2, total: 2 });
	expect(budget.reserve("R1")).toEqual({ caseCount: 3, total: 3 });
	expect(() => budget.reserve("R1")).toThrow("cap reached before dispatch");
	expect(budget.stopped).toBe("request-cap");
	expect(() => budget.reserve("E1")).toThrow("run stopped");
});

test("unknown case identity stops before any dispatch", () => {
	let budget = new JevBudget(["R1", "E1", "D1"]);
	expect(() => budget.reserve(undefined)).toThrow("no frozen case identity");
	expect(budget.stopped).toBe("unknown-case");
	expect(() => budget.reserve("R1")).toThrow("run stopped");
});

test("overall cap stops further cases", () => {
	let budget = new JevBudget(["R1", "E1", "D1", "extra"]);
	for (let id of ["R1", "E1", "D1"]) {
		for (let index = 0; index < 3; index++) budget.reserve(id);
	}
	expect(() => budget.reserve("extra")).toThrow("cap reached before dispatch");
	expect(budget.stopped).toBe("request-cap");
});

test("a provider or model failure stops later cases", () => {
	let budget = new JevBudget(["R1", "E1", "D1"]);
	budget.reserve("R1");
	budget.stop("model-drift");
	expect(() => budget.reserve("E1")).toThrow("run stopped: model-drift");
});
