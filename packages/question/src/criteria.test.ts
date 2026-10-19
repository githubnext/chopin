import { describe, expect, it } from "bun:test";

import { derive } from "./answer";
import { apply, create, crdt, read, restore, setMark } from "./draft";
import * as limits from "./limits";
import { addCriterion, addOption } from "./options";
import { appendCriterion, decision, identified, normalize } from "./schema";

function start(criteria: unknown = [{ label: "New device" }, { label: "Easy reset" }]) {
	// `start(null)` asks no criteria at all.
	let definition = decision(normalize({
		questions: [{
			header: "Auth",
			question: "How do we sign in?",
			multiple: false,
			options: [{ label: "Passkeys", description: "" }, { label: "Passwords", description: "" }],
			...(criteria === null ? {} : { criteria }),
		}],
	}));
	return { definition, model: create(definition) };
}

describe("criteria definition", () => {
	it("normalizes positional ids and freezes them", () => {
		let { definition } = start();
		expect(definition.questions[0]!.criteria).toEqual([
			{ id: "c0", label: "New device" },
			{ id: "c1", label: "Easy reset" },
		]);
		expect(Object.isFrozen(definition.questions[0]!.criteria)).toBe(true);
	});

	it("stays absent when none are asked", () => {
		expect(start(null).definition.questions[0]).not.toHaveProperty("criteria");
	});

	it("rejects bad criteria", () => {
		for (
			let criteria of [
				[],
				"x",
				[{ label: "" }],
				[{ label: "a".repeat(limits.MAX_CRITERION_LABEL + 1) }],
				[{ label: "A" }, { label: " a " }],
				[{ label: "A", extra: 1 }],
				Array.from({ length: limits.MAX_CRITERIA + 1 }, (_, i) => ({ label: `c${i}` })),
			]
		) expect(() => start(criteria)).toThrow();
	});

	it("rejects criteria on a written question", () => {
		expect(() =>
			normalize({
				questions: [{
					header: "h",
					question: "q",
					multiple: false,
					response: "text",
					options: [],
					criteria: [{ label: "A" }],
				}],
			})
		).toThrow();
	});

	it("validates stored criteria strictly and loads old definitions unchanged", () => {
		let { definition } = start();
		expect(identified(JSON.parse(JSON.stringify(definition)))).toBeTruthy();
		let { definition: plain } = start(null);
		expect(identified(JSON.parse(JSON.stringify(plain)))).toBeTruthy();
		let bad = JSON.parse(JSON.stringify(definition));
		bad.questions[0].criteria[0].id = "a/b";
		expect(() => identified(bad)).toThrow();
		bad = JSON.parse(JSON.stringify(definition));
		bad.questions[0].criteria[1].id = "c0";
		expect(() => identified(bad)).toThrow();
		bad = JSON.parse(JSON.stringify(definition));
		bad.questions[0].criteria[0].extra = true;
		expect(() => identified(bad)).toThrow();
	});
});

describe("marks", () => {
	it("starts empty and records marks through patches", () => {
		let { definition, model } = start();
		expect(read(model, definition).q0!.marks).toEqual({});

		let client = restore([...model.toBinary()], definition);
		setMark(client, "q0", "o0", "c0", "yes");
		setMark(client, "q0", "o1", "c1", "no");
		let patch = [...client.api.flush().toBinary()];
		let applied = apply(model, definition, patch);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(read(applied.model, definition).q0!.marks).toEqual({ "o0/c0": "yes", "o1/c1": "no" });

		// Changing and clearing an existing cell.
		let again = restore([...applied.model.toBinary()], definition);
		setMark(again, "q0", "o0", "c0", "partly");
		setMark(again, "q0", "o1", "c1", null);
		let next = apply(applied.model, definition, [...again.api.flush().toBinary()]);
		expect(next.ok && read(next.model, definition).q0!.marks).toEqual({ "o0/c0": "partly", "o1/c1": null });
	});

	it("rejects an invalid value, unknown cell or missing container", () => {
		let { definition, model } = start();
		for (
			let mutate of [
				(client: typeof model) => setMark(client, "q0", "o0", "c0", "maybe" as never),
				(client: typeof model) => setMark(client, "q0", "o9", "c0", "yes"),
				(client: typeof model) => setMark(client, "q0", "o0", "c9", "yes"),
				(client: typeof model) => client.api.obj(["q0"]).del(["marks"]),
			]
		) {
			let client = restore([...model.toBinary()], definition);
			mutate(client);
			let result = apply(model, definition, [...client.api.flush().toBinary()]);
			expect(result.ok).toBe(false);
		}
	});

	it("keeps an empty marks object when the question has no criteria", () => {
		let { definition, model } = start(null);
		expect(read(model, definition).q0).not.toHaveProperty("marks");
		let client = restore([...model.toBinary()], definition);
		client.api.obj(["q0", "marks"]).set({ "o0/c0": crdt.schema.val(crdt.schema.con("yes")) });
		expect(apply(model, definition, [...client.api.flush().toBinary()]).ok).toBe(false);
	});

	it("accepts a legacy draft without a marks object, but not on a written question", () => {
		let { definition } = start(null);
		let legacy = crdt.Model.create(crdt.schema.obj({
			q0: crdt.schema.obj({
				mode: crdt.schema.val(crdt.schema.con("choices")),
				choice: crdt.schema.val(crdt.schema.con(null)),
				options: crdt.schema.obj({}),
				custom: crdt.schema.str(""),
			}),
		}));
		legacy.api.flush();
		expect(read(legacy as never, definition).q0).toEqual({
			mode: "choices",
			choice: null,
			options: { o0: false, o1: false },
			custom: "",
		});

		let written = decision(normalize({
			questions: [{ header: "h", question: "q", multiple: false, response: "text", options: [] }],
		}));
		let text = create(written);
		let client = restore([...text.toBinary()], written);
		client.api.obj(["q0"]).set({ marks: crdt.schema.obj({}) });
		expect(apply(text, written, [...client.api.flush().toBinary()]).ok).toBe(false);
	});

	it("is carried into the derived answer", () => {
		let { definition, model } = start();
		setMark(model, "q0", "o0", "c0", "yes");
		setMark(model, "q0", "o1", "c0", "no");
		model.api.val(["q0", "choice"]).set("o0");
		let outcome = derive(definition, read(model, definition));
		expect(outcome.ok && outcome.answers[0]!.marks).toEqual({ "o0/c0": "yes", "o1/c0": "no" });
	});

	it("leaves an answer without criteria unchanged", () => {
		let { definition, model } = start(null);
		model.api.val(["q0", "choice"]).set("o0");
		let outcome = derive(definition, read(model, definition));
		expect(outcome.ok && outcome.answers[0]).not.toHaveProperty("marks");
	});
});

describe("appendCriterion", () => {
	let key = "criterion-1";

	it("appends and keeps existing marks", () => {
		let { definition, model } = start();
		setMark(model, "q0", "o0", "c0", "yes");
		let result = addCriterion(definition, model, "c9", " No new storage ");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.criterion).toEqual({ id: "c9", label: "No new storage" });
		let drafts = read(result.model, result.definition);
		expect(drafts.q0!.marks).toEqual({ "o0/c0": "yes" });
		setMark(result.model, "q0", "o1", "c9", "partly");
		expect(read(result.model, result.definition).q0!.marks!["o1/c9"]).toBe("partly");
	});

	it("adds the first criterion to a question that had none, without reshaping the draft", () => {
		let { definition, model } = start(null);
		let result = addCriterion(definition, model, "c0", "Cheap");
		expect(result.ok && read(result.model, result.definition).q0!.marks).toEqual({});
		// A client that already holds the old model can mark the new column.
		let client = restore([...model.toBinary()], definition);
		if (!result.ok) return;
		let later = restore([...client.toBinary()], result.definition);
		setMark(later, "q0", "o0", "c0", "no");
		let applied = apply(result.model, result.definition, [...later.api.flush().toBinary()]);
		expect(applied.ok && read(applied.model, result.definition).q0!.marks).toEqual({ "o0/c0": "no" });
	});

	it("keeps working when an option is appended afterwards", () => {
		let { definition, model } = start();
		let option = addOption(definition, model, "o9", "Magic links");
		expect(option.ok).toBe(true);
		if (!option.ok) return;
		setMark(option.model, "q0", "o9", "c1", "yes");
		expect(read(option.model, option.definition).q0!.marks).toEqual({ "o9/c1": "yes" });
	});

	it("refuses duplicates, a full set, text questions and bad input", () => {
		let { definition, model } = start();
		expect(addCriterion(definition, model, "c9", " new DEVICE ")).toMatchObject({
			ok: false,
			reason: "duplicate",
		});
		expect(addCriterion(definition, model, "c9", "")).toMatchObject({ ok: false, reason: "invalid" });
		expect(addCriterion(definition, model, "c9", "x".repeat(41))).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		let current = { definition, model };
		for (let index = 0; index < limits.MAX_CRITERIA - 2; index++) {
			let result = addCriterion(current.definition, current.model, `n${index}`, `Extra ${index}`);
			expect(result.ok).toBe(true);
			if (result.ok) current = result;
		}
		expect(addCriterion(current.definition, current.model, "n9", "One more")).toMatchObject({
			ok: false,
			reason: "full",
		});

		let written = decision(normalize({
			questions: [{ header: "h", question: "q", multiple: false, response: "text", options: [] }],
		}));
		expect(appendCriterion(written, { question: "q0", key, label: "A" }, "c0")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(appendCriterion(definition, { question: "q0", key: "short", label: "A" }, "c7"))
			.toMatchObject({ ok: false, reason: "invalid" });
	});

	it("does not mutate its inputs", () => {
		let { definition, model } = start();
		let before = [...model.toBinary()];
		addCriterion(definition, model, "c9", "Cheap");
		expect([...model.toBinary()]).toEqual(before);
		expect(definition.questions[0]!.criteria).toHaveLength(2);
	});
});
