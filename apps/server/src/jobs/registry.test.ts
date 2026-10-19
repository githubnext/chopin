import { expect, it } from "bun:test";

import { executionDiagnostic } from "./registry";

function keys(count: number): Record<string, number> {
	return Object.fromEntries(Array.from({ length: count }, (_, index) => [`key${index}`, index]));
}

it("accepts twenty diagnostic keys and rejects twenty-one", () => {
	expect(Object.keys(executionDiagnostic(keys(20))!)).toHaveLength(20);
	expect(() => executionDiagnostic(keys(21))).toThrow("execution diagnostic is invalid");
});
