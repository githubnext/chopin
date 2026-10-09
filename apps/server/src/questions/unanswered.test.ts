import { describe, expect, it } from "bun:test";

import { migratedUnansweredDecisions } from "../storage/postgres/migrations/017_unanswered_decisions";
import { sidecarUnansweredDecisions, unansweredDecisions } from "./unanswered";
import { UNANSWERED_SIDECARS } from "./unanswered.test-fixtures";

describe("unanswered decisions", () => {
	for (let { name, sidecar, expected } of UNANSWERED_SIDECARS) {
		it(name, () => {
			expect(sidecarUnansweredDecisions(sidecar)).toBe(expected);
			expect(migratedUnansweredDecisions(sidecar)).toBe(expected);
			expect(migratedUnansweredDecisions(JSON.stringify(sidecar))).toBe(expected);
		});
	}

	it("counts records directly", () => {
		expect(unansweredDecisions([
			{ status: "open", definition: { questions: [{ id: "a" }] } },
			{ status: "answered", definition: { questions: [{ id: "b" }] } },
		])).toBe(1);
		expect(unansweredDecisions(undefined)).toBe(0);
	});
});
