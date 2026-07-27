import { describe, expect, it } from "bun:test";

import { derive, incomplete, summarize } from "./answer";
import { answered, assertPatch, create, read } from "./draft";
import * as limits from "./limits";
import { normalize, QuestionError } from "./schema";

import type { Definition } from "./schema";

function tool(overrides: Record<string, unknown> = {}) {
	return {
		questions: [
			{
				header: "Rollout",
				question: "How should we deploy?",
				multiple: false,
				options: [
					{ label: "Canary", description: "Small percentage first." },
					{ label: "Blue-green", description: "" },
				],
				...overrides,
			},
		],
	};
}

describe("normalize", () => {
	it("accepts a well-formed definition and freezes it", () => {
		let definition = normalize(tool());

		expect(definition.questions).toHaveLength(1);
		expect(definition.questions[0]!.id).toBe("q0");
		expect(definition.questions[0]!.options.map(option => option.id)).toEqual(["o0", "o1"]);
		expect(Object.isFrozen(definition)).toBe(true);
		expect(Object.isFrozen(definition.questions[0])).toBe(true);
	});

	it("trims text and keeps optional descriptions empty rather than absent", () => {
		let definition = normalize(tool({ header: "  Rollout  " }));
		expect(definition.questions[0]!.header).toBe("Rollout");
		expect(definition.questions[0]!.options[1]!.description).toBe("");
	});

	it("rejects unknown fields instead of ignoring them", () => {
		expect(() => normalize({ questions: [], extra: 1 })).toThrow(QuestionError);
		expect(() => normalize(tool({ colour: "red" }))).toThrow(/invalid fields/);
	});

	it("requires at least one question and one option", () => {
		expect(() => normalize({ questions: [] })).toThrow(/At least one question/);
		expect(() => normalize(tool({ options: [] }))).toThrow(/at least one option/);
	});

	it("enforces the documented limits", () => {
		expect(() => normalize({ questions: Array.from({ length: 11 }, () => tool().questions[0]) }))
			.toThrow(/at most 10 questions/);
		expect(() => normalize(tool({ header: "x".repeat(limits.MAX_HEADER + 1) })))
			.toThrow(/exceeds 80 characters/);
	});

	it("requires multiple to be a boolean", () => {
		expect(() => normalize(tool({ multiple: "yes" }))).toThrow(/must be a boolean/);
	});
});

describe("draft", () => {
	let definition: Definition = normalize(tool());

	it("creates a draft matching the definition's shape", () => {
		let drafts = read(create(definition), definition);

		expect(Object.keys(drafts)).toEqual(["q0"]);
		expect(drafts.q0).toEqual({
			mode: "choices",
			choice: null,
			options: { o0: false, o1: false },
			custom: "",
		});
	});

	it("rejects a model whose shape does not match", () => {
		let other = normalize({
			questions: [{
				header: "Other",
				question: "?",
				multiple: false,
				options: [{ label: "a", description: "" }],
			}],
		});
		// A draft built for one definition must not validate against another.
		expect(() => read(create(other), definition)).toThrow(QuestionError);
	});

	it("recognises when a question has an answer", () => {
		let question = definition.questions[0]!;

		expect(answered(question, undefined)).toBe(false);
		expect(answered(question, { mode: "choices", choice: null, options: {}, custom: "" }))
			.toBe(false);
		expect(answered(question, { mode: "choices", choice: "o0", options: {}, custom: "" }))
			.toBe(true);
		// Custom mode ignores choices entirely; the two are alternatives.
		expect(answered(question, { mode: "custom", choice: "o0", options: {}, custom: "  " }))
			.toBe(false);
		expect(answered(question, { mode: "custom", choice: null, options: {}, custom: "Other" }))
			.toBe(true);
	});

	it("rejects malformed patches before they are applied", () => {
		expect(() => assertPatch([])).toThrow(/empty/);
		expect(() => assertPatch([1, 999])).toThrow(/invalid bytes/);
		expect(() => assertPatch(Array.from({ length: limits.MAX_PATCH_BYTES + 1 }, () => 0)))
			.toThrow(/patch limit/);
	});
});

describe("derive", () => {
	let definition = normalize(tool());

	it("returns the chosen labels, not identifiers", () => {
		let outcome = derive(definition, {
			q0: { mode: "choices", choice: "o0", options: {}, custom: "" },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.answers).toEqual([
			{ question: "How should we deploy?", choices: ["Canary"] },
		]);
	});

	it("returns custom text when that is the mode", () => {
		let outcome = derive(definition, {
			q0: { mode: "custom", choice: null, options: {}, custom: "  Ship it  " },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.answers[0]).toEqual({ question: "How should we deploy?", custom: "Ship it" });
	});

	it("refuses a partial submission and names the question at fault", () => {
		let outcome = derive(definition, {
			q0: { mode: "choices", choice: null, options: {}, custom: "" },
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.question).toBe("q0");
		expect(outcome.message).toContain("Rollout");
	});

	it("collects every selection for a multiple-choice question", () => {
		let many = normalize(tool({ multiple: true }));
		let outcome = derive(many, {
			q0: { mode: "choices", choice: null, options: { o0: true, o1: true }, custom: "" },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.answers[0]!.choices).toEqual(["Canary", "Blue-green"]);
	});

	it("reports the first unanswered question", () => {
		let two = normalize({
			questions: [tool().questions[0], { ...tool().questions[0], header: "Second" }],
		});

		expect(incomplete(two, {})).toBe("q0");
		expect(
			incomplete(two, { q0: { mode: "choices", choice: "o0", options: {}, custom: "" } }),
		).toBe("q1");
	});

	it("summarises an answer for plan source", () => {
		expect(summarize({ question: "?", choices: ["Canary", "Blue-green"] }))
			.toBe("Canary, Blue-green");
		expect(summarize({ question: "?", custom: "Something else" })).toBe("Something else");
	});
});
