import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $getRoot } from "lexical";

import { importPlan, registry } from "@chopin/dialect";

import { collectPlanState } from "./questionnaires";

import type { LexicalEditor } from "lexical";
import type { PlanQuestionnaireState } from "./questionnaires";

const REGISTRY = registry();
const QUESTIONNAIRE = `<Questionnaire id="01K0N4TR8K7JGM4R1J7PW4R8YJ">\n`
	+ `<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" header="Rollout" `
	+ `prompt="How should we deploy?" multiple="false">\n`
	+ `<Option id="01K0N4W3B7P27CBAEC7A8C8WEA" label="Canary" />\n`
	+ `</Question>\n`
	+ `</Questionnaire>\n`;

function open(source: string): LexicalEditor {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
	importPlan(editor, source, { registry: REGISTRY });
	return editor;
}

function state(source: string) {
	let editor = open(source);
	return read(editor);
}

function read(editor: LexicalEditor): PlanQuestionnaireState {
	let value: PlanQuestionnaireState | undefined;
	editor.getEditorState().read(() => {
		value = collectPlanState();
	});
	if (!value) throw new Error("could not read plan questionnaire state");
	return value;
}

describe("plan questionnaire state", () => {
	it("keeps a questionnaire-only document out of plan content", () => {
		expect(state("")).toEqual({ entries: [], hasPlanContent: false });

		let emptyParagraph = open("");
		emptyParagraph.update(() => {
			$getRoot().append($createParagraphNode());
		}, { discrete: true });
		expect(read(emptyParagraph)).toEqual({ entries: [], hasPlanContent: false });

		expect(state(QUESTIONNAIRE)).toMatchObject({
			entries: [{ id: "01K0N4TR8K7JGM4R1J7PW4R8YJ" }],
			hasPlanContent: false,
		});
	});

	it("recognises ordinary plan blocks as plan content", () => {
		for (
			let source of [
				"The renderer caches tiles for 60 seconds.\n",
				"| Name |\n| ---- |\n| API  |\n",
				"![Diagram](https://example.com/diagram.png)\n",
				"```ts\nlet answer = 42;\n```\n",
			]
		) {
			expect(state(source)).toEqual({ entries: [], hasPlanContent: true });
		}
	});
});
