import { describe, expect, it } from "bun:test";

import { derive, incomplete, summarize } from "./answer";
import { answered, apply, assertPatch, crdt, create, read } from "./draft";
import * as limits from "./limits";
import { identified } from "./index";
import { appendOption, normalize, QuestionError } from "./schema";

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
	it("supports verbatim host dialogs without choices, including empty text replies", () => {
		let definition = normalize(tool({ header: "  Title  ", options: [] }), { verbatim: true });
		expect(definition.questions[0]!.header).toBe("  Title  ");
		let drafts = read(create(definition), definition);
		expect(drafts.q0!.mode).toBe("custom");
		for (let custom of ["", "  ", "  answer\n"]) {
			drafts.q0!.custom = custom;
			expect(derive(definition, drafts)).toEqual({
				ok: true,
				answers: [{ question: "How should we deploy?", custom }],
			});
		}
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

describe("identified", () => {
	it("preserves stored IDs, text, and order without copying the definition", () => {
		let source = {
			questions: [{
				id: "question-z",
				header: "  Rollout  ",
				question: "How?",
				multiple: false,
				options: [
					{ id: "option-z", label: "Canary", description: "" },
					{ id: "option-a", label: "Blue-green", description: "" },
				],
			}, {
				id: "question-a",
				header: "Timing",
				question: "When?",
				multiple: false,
				options: [{ id: "option-t", label: "Today", description: "" }],
			}],
		};
		let before = structuredClone(source);
		expect(identified(source)).toBe(source);
		expect(source).toEqual(before);
		expect(source.questions.map(question => question.id)).toEqual(["question-z", "question-a"]);
		expect(source.questions[0]!.options.map(option => option.id)).toEqual(["option-z", "option-a"]);
	});
	it("accepts a pending single-choice card with no quoted options but keeps tool input strict", () => {
		let pending = {
			questions: [{
				id: "q1",
				header: "Auth",
				question: "What auth system should we use?",
				multiple: false,
				options: [],
			}],
		};
		expect(identified(pending)).toBe(pending);
		expect(read(create(pending), pending).q1).toEqual({
			mode: "choices",
			choice: null,
			options: {},
			custom: "",
		});
		expect(derive(pending, read(create(pending), pending)).ok).toBe(false);
		expect(() => normalize(tool({ options: [] }))).toThrow(/at least one option/);
		expect(() =>
			identified({
				questions: [{ ...pending.questions[0], multiple: true }],
			})
		).toThrow(/invalid options/);
	});

	it("keeps stable IDs and refuses oversized raw values with surrounding spaces", () => {
		let source = {
			questions: [{
				id: "q1",
				header: "Rollout",
				question: "How?",
				multiple: false,
				options: [{ id: "o1", label: "Canary", description: "" }],
			}],
		};
		expect(identified(source)).toBe(source);
		expect(() =>
			identified({
				questions: [{ ...source.questions[0], id: ` ${"q".repeat(limits.MAX_CALL_ID)} ` }],
			})
		).toThrow(/exceeds/);
		expect(() =>
			identified({
				questions: [{ ...source.questions[0], header: ` ${"x".repeat(limits.MAX_HEADER)} ` }],
			})
		).toThrow(/exceeds/);
		expect(() =>
			identified({
				questions: [{
					...source.questions[0],
					options: [{
						...source.questions[0]!.options[0],
						label: ` ${"x".repeat(limits.MAX_LABEL)} `,
					}],
				}],
			})
		).toThrow(/exceeds/);
	});

	it("rejects duplicate question IDs and option IDs across the questionnaire", () => {
		let question = {
			id: "q1",
			header: "Rollout",
			question: "How?",
			multiple: false,
			options: [{ id: "o1", label: "Canary", description: "" }],
		};
		expect(() => identified({ questions: [question, { ...question }] }))
			.toThrow(/duplicate question IDs/);
		expect(() => identified({ questions: [question, { ...question, id: "q2" }] }))
			.toThrow(/duplicate option IDs/);
		expect(() =>
			identified({
				questions: [{ ...question, options: [...question.options, ...question.options] }],
			})
		)
			.toThrow(/duplicate option IDs/);
	});

	it("rejects unknown fields at every stored definition level", () => {
		let question = {
			id: "q1",
			header: "Rollout",
			question: "How?",
			multiple: false,
			options: [{ id: "o1", label: "Canary", description: "" }],
		};
		for (
			let source of [
				{ questions: [question], extra: true },
				{ questions: [{ ...question, extra: true }] },
				{ questions: [{ ...question, options: [{ ...question.options[0], extra: true }] }] },
			]
		) expect(() => identified(source)).toThrow(/invalid fields/);
	});

	it("enforces question and option counts and rejects empty options for multiple questions", () => {
		let question = {
			id: "q1",
			header: "Rollout",
			question: "How?",
			multiple: false,
			options: [{ id: "o1", label: "Canary", description: "" }],
		};
		let questions = Array.from({ length: limits.MAX_QUESTIONS }, (_, index) => ({
			...question,
			id: `q${index}`,
			options: [{ ...question.options[0], id: `o${index}` }],
		}));
		expect(identified({ questions }).questions).toHaveLength(limits.MAX_QUESTIONS);
		expect(() => identified({ questions: [] })).toThrow(/invalid question count/);
		expect(() => identified({ questions: [...questions, { ...question, id: "extra" }] }))
			.toThrow(/invalid question count/);
		let options = Array.from({ length: limits.MAX_OPTIONS }, (_, index) => ({
			...question.options[0],
			id: `o${index}`,
		}));
		expect(identified({ questions: [{ ...question, options }] }).questions[0]!.options)
			.toHaveLength(limits.MAX_OPTIONS);
		expect(() =>
			identified({
				questions: [{
					...question,
					options: [...options, { id: "extra", label: "Extra", description: "" }],
				}],
			})
		)
			.toThrow(/invalid options/);
		expect(() =>
			identified({ questions: [{ ...question, options: [] }, { ...question, id: "q2" }] })
		)
			.toThrow(/invalid options/);
		expect(() => identified({ questions: [{ ...question, multiple: "yes" }] }))
			.toThrow(/invalid options/);
	});

	it("bounds every raw text field and rejects blank identifiers and required text", () => {
		let question = {
			id: "q1",
			header: "Rollout",
			question: "How?",
			multiple: false,
			options: [{ id: "o1", label: "Canary", description: "" }],
		};
		for (
			let [field, maximum] of [
				["id", limits.MAX_CALL_ID],
				["header", limits.MAX_HEADER],
				["question", limits.MAX_QUESTION],
			] as const
		) {
			expect(() => identified({ questions: [{ ...question, [field]: " " }] })).toThrow(
				QuestionError,
			);
			expect(() =>
				identified({ questions: [{ ...question, [field]: ` ${"x".repeat(maximum)} ` }] })
			)
				.toThrow(/exceeds/);
		}
		for (
			let [field, maximum] of [
				["id", limits.MAX_CALL_ID],
				["label", limits.MAX_LABEL],
				["description", limits.MAX_DESCRIPTION],
			] as const
		) {
			let options = [{ ...question.options[0], [field]: ` ${"x".repeat(maximum)} ` }];
			expect(() => identified({ questions: [{ ...question, options }] })).toThrow(/exceeds/);
			if (field !== "description") {
				expect(() =>
					identified({
						questions: [{ ...question, options: [{ ...question.options[0], [field]: " " }] }],
					})
				)
					.toThrow(QuestionError);
			}
		}
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
				options: [{ label: "a", description: "" }, { label: "b", description: "" }, {
					label: "c",
					description: "",
				}],
			}],
		});
		// A draft built for one definition must not validate against another:
		// it may lack keys (options appended later) but never hold unknown ones.
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

	it("returns the chosen labels and option identifiers", () => {
		let outcome = derive(definition, {
			q0: { mode: "choices", choice: "o0", options: {}, custom: "" },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.answers).toEqual([
			{ question: "How should we deploy?", choices: ["Canary"], optionIds: ["o0"] },
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
		expect(outcome.answers[0]!.optionIds).toEqual(["o0", "o1"]);
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

const KEY = "0123456789abcdef";

describe("appendOption", () => {
	let definition = normalize(tool());
	let question = definition.questions[0]!.id;
	let input = (label: unknown, extra: Record<string, unknown> = {}) => ({
		question,
		key: KEY,
		label,
		...extra,
	});

	it("returns a new frozen definition with the option last", () => {
		let single = { questions: [definition.questions[0]!] as [(typeof definition.questions)[0]] };
		let result = appendOption(single, input("  Shadow  ", { description: " dark " }), "NEW");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.option).toEqual({ id: "NEW", label: "Shadow", description: "dark" });
		expect(result.definition.questions[0].options.map(option => option.id)).toEqual([
			"o0",
			"o1",
			"NEW",
		]);
		expect(Object.isFrozen(result.definition.questions[0].options)).toBe(true);
		// The original is untouched.
		expect(single.questions[0].options).toHaveLength(2);
	});

	let single = { questions: [definition.questions[0]!] as [(typeof definition.questions)[0]] };

	it("rejects empty, oversized, or non-text labels", () => {
		for (let label of ["   ", "x".repeat(limits.MAX_LABEL + 1), 4, undefined]) {
			let result = appendOption(single, input(label), "NEW");
			expect(result.ok ? "ok" : result.reason).toBe("invalid");
		}
	});

	it("rejects a case-insensitive duplicate", () => {
		let result = appendOption(single, input("  canary "), "NEW");
		expect(result.ok ? "ok" : result.reason).toBe("duplicate");
	});

	it("rejects an unknown question and a malformed key", () => {
		expect(appendOption(single, { ...input("x"), question: "nope" }, "NEW").ok).toBe(false);
		expect(appendOption(single, { ...input("x"), key: "short" }, "NEW").ok).toBe(false);
	});

	it("stops at the option limit", () => {
		let current = single;
		for (let index = 0; index < limits.MAX_SHARED_OPTIONS - 2; index++) {
			let result = appendOption(current, input(`Extra ${index}`), `ID${index}`);
			expect(result.ok).toBe(true);
			if (result.ok) current = result.definition;
		}
		let result = appendOption(current, input("One more"), "LAST");
		expect(result.ok ? "ok" : result.reason).toBe("full");
	});

	it("keeps an existing draft valid and lets the new option be chosen", () => {
		let model = create(single);
		let result = appendOption(single, input("Shadow"), "NEW");
		if (!result.ok) throw new Error("append failed");

		// The old draft reads against the larger definition; the new option is unselected.
		let drafts = read(model, result.definition);
		expect(drafts[question]!.options).toEqual({ o0: false, o1: false, NEW: false });

		// A client selects it by creating its key.
		let fork = model.fork();
		fork.api.obj([question, "options"]).set({
			NEW: crdt.schema.val(crdt.schema.con(true)),
		});
		let patch = fork.api.flush();
		let applied = apply(model, result.definition, [...patch.toBinary()]);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(read(applied.model, result.definition)[question]!.options.NEW).toBe(true);

		// Against the old definition the same patch is an unknown key.
		expect(apply(model, single, [...patch.toBinary()]).ok).toBe(false);
	});
});
