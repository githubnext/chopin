import { describe, expect, it } from "bun:test";

import { inlineMemberState } from "./questionnaire";

import type { Questionnaire } from "@chopin/dialect";

let value = (answer?: string): Questionnaire => ({
	id: "w",
	questions: [{
		id: "q",
		header: "H",
		prompt: "P?",
		multiple: false,
		options: [],
		...(answer === undefined ? {} : { answer }),
	}],
});
let meta = (status: "open" | "decided" | "discarded", hasProse = false) => ({
	status,
	origin: "planner" as const,
	involved: [],
	history: [],
	optionOrigins: {},
	hasProse,
	refining: false,
	proseOrphaned: false,
});

describe("inline deck membership", () => {
	it("joins open cards", () => {
		expect(inlineMemberState(value(), meta("open"), undefined, false)).toBe("open");
	});
	it("keeps a prose-less decided card as a settled member", () => {
		expect(inlineMemberState(value("A"), meta("decided"), undefined, false)).toBe("settled");
	});
	it("leaves hidden cards out", () => {
		expect(inlineMemberState(value("A"), meta("discarded"), undefined, false)).toBe("hidden");
		expect(inlineMemberState(value("A"), meta("decided", true), undefined, false)).toBe("hidden");
		expect(inlineMemberState(value("A"), meta("decided"), { q: 1 }, false)).toBe("hidden");
	});
});
