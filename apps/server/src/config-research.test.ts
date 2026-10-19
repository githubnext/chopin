import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("RESEARCH_EVIDENCE_TIMEOUT_MS defaults to ten minutes", () => {
	expect(configured().researchEvidenceTimeoutMs).toBe(600_000);
});

test("RESEARCH_EVIDENCE_TIMEOUT_MS accepts whole milliseconds within its bounds", () => {
	for (let value of ["120000", "600000", "1800000"]) {
		expect(configured({ RESEARCH_EVIDENCE_TIMEOUT_MS: value }).researchEvidenceTimeoutMs)
			.toBe(Number(value));
	}
});

test("RESEARCH_EVIDENCE_TIMEOUT_MS rejects out-of-range and malformed values", () => {
	for (let value of ["", "119999", "1800001", "-1", "1e6", "600.5", "ten", "0x10", " 600000"]) {
		expect(() => configured({ RESEARCH_EVIDENCE_TIMEOUT_MS: value })).toThrow(
			"RESEARCH_EVIDENCE_TIMEOUT_MS must be an integer between 120000 and 1800000 milliseconds",
		);
	}
});
