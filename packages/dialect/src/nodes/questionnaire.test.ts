import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $isElementNode } from "lexical";

import { exportPlan, importPlan } from "../convert";
import { registry } from "../registry";
import { $isQuestionnaireNode } from "./questionnaire";

import type { LexicalEditor } from "lexical";

const REGISTRY = registry();

const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const CANARY = "01K0N4W3B7P27CBAEC7A8C8WEA";
const BLUE = "01K0N4X2M5R8T3VQ7YB6ZC4DEF";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
}

function through(source: string): string {
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	return exportPlan(instance, { registry: REGISTRY });
}

const OPEN = `<Questionnaire id="${ID}">\n`
	+ `<Question id="${QUESTION}" header="Rollout" `
	+ `prompt="How should we deploy?" multiple="false">\n`
	+ `<Option id="${CANARY}" label="Canary" description="Small percentage first." />\n`
	+ `<Option id="${BLUE}" label="Blue-green" />\n`
	+ `</Question>\n`
	+ `</Questionnaire>\n`;

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

	it("omits optional option descriptions", () => {
		let out = through(OPEN);
		let blue = out.split("\n").find(line => line.includes("Blue-green"));
		expect(blue).not.toContain("description=");
	});
});
