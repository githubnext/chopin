import { describe, expect, it } from "bun:test";

import { create, read } from "./draft";
import { derive } from "./answer";
import * as limits from "./limits";
import { addOption } from "./options";
import { decision, identified, normalize } from "./schema";

function start(count = 2) {
	let definition = decision(normalize({
		questions: [{
			header: "Auth",
			question: "What auth system should we use?",
			multiple: false,
			options: Array.from({ length: count }, (_, index) => ({
				label: `Option ${index}`,
				description: "",
			})),
		}],
	}));
	return { definition, model: create(definition) };
}

describe("addOption", () => {
	it("appends an option to the definition and an unselected register to the draft", () => {
		let { definition, model } = start();
		let result = addOption(definition, model, "o9", "  GitHub Apps ");

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.option).toEqual({ id: "o9", label: "GitHub Apps", description: "" });
		expect(result.definition.questions[0]!.options.map(option => option.id)).toEqual([
			"o0",
			"o1",
			"o9",
		]);
		let drafts = read(result.model, result.definition);
		expect(drafts.q0!.options).toEqual({ o0: false, o1: false, o9: false });
	});

	it("keeps an existing selection", () => {
		let { definition, model } = start();
		model.api.val(["q0", "choice"]).set("o1");
		let result = addOption(definition, model, "o9", "Roll our own");
		expect(result.ok && read(result.model, result.definition).q0!.choice).toBe("o1");
	});

	it("does not mutate its inputs", () => {
		let { definition, model } = start();
		let before = [...model.toBinary()];
		addOption(definition, model, "o9", "Roll our own");
		expect([...model.toBinary()]).toEqual(before);
		expect(definition.questions[0]!.options).toHaveLength(2);
	});

	it("refuses a duplicate label, ignoring case and surrounding space", () => {
		let { definition, model } = start();
		let result = addOption(definition, model, "o9", " option 1 ");
		expect(result).toMatchObject({ ok: false, reason: "duplicate" });
	});

	it("refuses an existing option ID without clearing its draft selection", () => {
		let { definition } = start();
		let multiple = decision({
			questions: [{ ...definition.questions[0]!, multiple: true }],
		});
		let model = create(multiple);
		model.api.val(["q0", "options", "o1"]).set(true);
		model.api.flush();
		let before = [...model.toBinary()];

		expect(addOption(multiple, model, "o1", "Another option")).toMatchObject({
			ok: false,
			reason: "duplicate",
		});
		expect(read(model, multiple).q0!.options.o1).toBe(true);
		expect([...model.toBinary()]).toEqual(before);
	});

	it("refuses an empty or over-long label", () => {
		let { definition, model } = start();
		expect(addOption(definition, model, "o9", "   ")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(addOption(definition, model, "o9", "x".repeat(limits.MAX_LABEL + 1)))
			.toMatchObject({ ok: false, reason: "invalid" });
	});

	it("refuses once the card holds the decision-card maximum", () => {
		let { definition, model } = start(limits.MAX_DECISION_OPTIONS);
		expect(addOption(definition, model, "o99", "One more")).toMatchObject({
			ok: false,
			reason: "full",
		});
	});
});

it("a pending card grows its first option and derives its selected label and ID", () => {
	let definition = decision(identified({
		questions: [{
			id: "pending",
			header: "Auth",
			question: "Which system?",
			multiple: false,
			options: [],
		}],
	}));
	let model = create(definition);
	let added = addOption(definition, model, "stable-option", "GitHub Apps");
	expect(added.ok).toBe(true);
	if (!added.ok) return;
	expect(read(added.model, added.definition).pending!.mode).toBe("choices");
	added.model.api.val(["pending", "choice"]).set("stable-option");
	added.model.api.flush();
	expect(derive(added.definition, read(added.model, added.definition))).toEqual({
		ok: true,
		answers: [{
			question: "Which system?",
			choices: ["GitHub Apps"],
			optionIds: ["stable-option"],
		}],
	});
});
