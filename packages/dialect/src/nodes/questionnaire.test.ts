import { describe, expect, it } from "bun:test";
import { $getRoot, $isElementNode } from "lexical";

import { importPlan } from "../convert";
import { $isQuestionnaireNode } from "./questionnaire";

import { editor, ID, OPEN, REGISTRY, through } from "./questionnaire.test-fixtures";

describe("questionnaire", () => {
	it("round-trips an open questionnaire", () => {
		let out = through(OPEN);
		expect(through(out)).toBe(out);
		expect(out).toContain(`id="${ID}"`);
		expect(out).toContain('header="Rollout"');
		expect(out).toContain('label="Canary"');
		expect(out).toContain('description="Small percentage first."');
		expect(out).toContain('multiple="false"');
	});

	it("round-trips a resolved answer projection", () => {
		let source = OPEN.replace(
			"</Question>",
			`<Answer value="Canary" />\n</Question>`,
		);
		let out = through(source);
		expect(through(out)).toBe(out);
		expect(out).toContain('<Answer value="Canary"');
	});

	it("gives the answer projection no identity of its own", () => {
		let source = OPEN.replace(
			"</Question>",
			`<Answer value="Canary" />\n</Question>`,
		);
		let answer = through(source).split("\n").find(line => line.includes("<Answer"));
		// It is addressed through its Question; a second id would duplicate identity.
		expect(answer).not.toContain("id=");
	});

	it("imports as one atomic node", () => {
		let instance = editor();
		importPlan(instance, OPEN, { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let node = $getRoot().getFirstChild();
			expect($isQuestionnaireNode(node)).toBe(true);
			if (!$isQuestionnaireNode(node)) return;

			// A decorator, not an element: there is no editable subtree inside.
			expect($isElementNode(node)).toBe(false);

			let value = node.getQuestionnaire();
			expect(value.id).toBe(ID);
			expect(value.questions).toHaveLength(1);
			expect(value.questions[0]!.options.map(option => option.label)).toEqual([
				"Canary",
				"Blue-green",
			]);
			expect(value.questions[0]!.answer).toBeUndefined();
		});
	});

	it("exposes the resolved answer to renderers", () => {
		let instance = editor();
		importPlan(
			instance,
			OPEN.replace("</Question>", `<Answer value="Canary" />\n</Question>`),
			{ registry: REGISTRY },
		);

		instance.getEditorState().read(() => {
			let node = $getRoot().getFirstChild();
			if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
			expect(node.getQuestionnaire().questions[0]!.answer).toBe("Canary");
		});
	});

	/**
	 * On the questionnaire rather than on each answer: it resolves as a unit,
	 * so every answer would otherwise repeat the same handle and the same
	 * moment. `<Decision>` records its provenance the same way.
	 */
	it("round-trips who settled it and when", () => {
		let source = OPEN
			.replace(
				`<Questionnaire id="${ID}">`,
				`<Questionnaire id="${ID}" by="ana" at="2026-07-28T10:14:00Z">`,
			)
			.replace("</Question>", `<Answer value="Canary" />\n</Question>`);

		let out = through(source);
		expect(through(out)).toBe(out);
		expect(out).toContain('by="ana"');
		expect(out).toContain('at="2026-07-28T10:14:00Z"');

		let instance = editor();
		importPlan(instance, source, { registry: REGISTRY });
		instance.getEditorState().read(() => {
			let node = $getRoot().getFirstChild();
			if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
			expect(node.getQuestionnaire()).toMatchObject({ by: "ana", at: "2026-07-28T10:14:00Z" });
		});
	});

	/** One answered before any of this was recorded has neither, for good. */
	it("carries no provenance when none was recorded", () => {
		let out = through(OPEN);
		expect(out).not.toContain("by=");
		expect(out).not.toContain("at=");
	});

	it("omits optional option descriptions", () => {
		let out = through(OPEN);
		let blue = out.split("\n").find(line => line.includes("Blue-green"));
		expect(blue).not.toContain("description=");
	});
});
