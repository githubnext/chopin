import { expect, test } from "bun:test";
import * as Question from "./index";

function input(overrides: Record<string, unknown> = {}) {
	return {
		questions: [{
			header: "Onboarding",
			question: "How should onboarding work?",
			response: "text",
			multiple: false,
			options: [],
			...overrides,
		}],
	};
}

test("written decisions start before alternatives exist and require nonempty prose", () => {
	let definition = Question.normalize(input());
	let model = Question.create(definition);
	let drafts = Question.read(model, definition);
	expect(drafts.q0).toEqual({ mode: "custom", choice: null, options: {}, custom: "" });
	expect(Question.derive(definition, drafts).ok).toBe(false);
	model.api.str(["q0", "custom"]).ins(0, "  Start by doing one small task.\n  ");
	let restored = Question.restore([...model.toBinary()], definition);
	expect(Question.derive(definition, Question.read(restored, definition))).toEqual({
		ok: true,
		answers: [{
			question: "How should onboarding work?",
			custom: "Start by doing one small task.",
		}],
	});
});

test("written decisions reject invalid modes and preserve the existing bounds", () => {
	for (let response of ["choices", null, false, undefined]) {
		expect(() => Question.normalize(input({ response }))).toThrow(/response/);
	}
	expect(() => Question.normalize(input({ multiple: true }))).toThrow(/cannot be multiple/);
	expect(() => Question.normalize(input(), { verbatim: true })).toThrow(/verbatim/);
	let definition = Question.normalize(input());
	expect(() =>
		Question.identified({
			questions: [{ ...definition.questions[0], multiple: true }],
		})
	).toThrow(/text response/);
	expect(() =>
		Question.identified({
			questions: [{ ...definition.questions[0], verbatim: true }],
		})
	).toThrow(/text response/);
	let model = Question.create(definition);
	model.api.str(["q0", "custom"]).ins(0, "x".repeat(Question.limits.MAX_CUSTOM + 1));
	expect(() => Question.read(model, definition)).toThrow(/exceeds/);
});

test("written answers reject options at creation and through either addition path", () => {
	let option = { label: "Guided task", description: "Try it immediately" };
	expect(() => Question.normalize(input({ options: [option] }))).toThrow(/cannot have options/);
	let definition = Question.decision(Question.normalize(input()));
	expect(() =>
		Question.identified({
			questions: [{
				...definition.questions[0],
				options: [{ ...option, id: "o1" }],
			}],
		})
	).toThrow(/invalid options/);
	let model = Question.create(definition);
	model.api.str(["q0", "custom"]).ins(0, "Use a small task.");
	model.api.flush();
	expect(Question.appendOption(definition, {
		question: "q0",
		key: "option-once",
		...option,
	}, "o1")).toMatchObject({ ok: false, reason: "invalid" });
	expect(Question.addOption(definition, model, "o1", option.label))
		.toMatchObject({ ok: false, reason: "invalid" });
	expect(Question.read(model, definition).q0).toMatchObject({
		mode: "custom",
		custom: "Use a small task.",
		options: {},
	});
	let fork = model.fork() as Question.Model;
	fork.api.val(["q0", "mode"]).set("choices");
	expect(Question.apply(model, definition, [...fork.api.flush().toBinary()]).ok).toBe(false);
	expect(
		Question.derive(definition, {
			q0: { mode: "choices", choice: null, options: {}, custom: "Use a small task." },
		}).ok,
	).toBe(false);
});

test("concurrent prose edits at separate positions merge in either arrival order", () => {
	let definition = Question.normalize(input());
	let model = Question.create(definition);
	model.api.str(["q0", "custom"]).ins(0, "Use a task.");
	model.api.flush();
	let first = model.fork() as Question.Model;
	let second = model.fork() as Question.Model;
	first.api.str(["q0", "custom"]).ins(0, "Start here: ");
	second.api.str(["q0", "custom"]).ins("Use a task.".length, " Offer help.");
	let a = [...first.api.flush().toBinary()];
	let b = [...second.api.flush().toBinary()];
	for (let patches of [[a, b], [b, a]]) {
		let merged = model;
		for (let patch of patches) {
			let result = Question.apply(merged, definition, patch);
			if (!result.ok) throw new Error(result.message);
			merged = result.model;
		}
		expect(Question.read(merged, definition).q0?.custom)
			.toBe("Start here: Use a task. Offer help.");
	}
});
