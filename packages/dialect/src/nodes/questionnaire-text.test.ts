import { expect, test } from "bun:test";
import { exportPlan, importPlan } from "../convert";
import { fromElement } from "./questionnaire";
import {
	CANARY,
	editor,
	ID,
	parsed,
	QUESTION,
	REGISTRY,
	through,
} from "./questionnaire.test-fixtures";

function source(children = "", attributes = "", status = "open") {
	return `<Questionnaire id="${ID}" status="${status}">\n`
		+ `<Question id="${QUESTION}" header="Onboarding" prompt="How should onboarding work?" `
		+ `description="Help people learn by doing" response="text" multiple="false" ${attributes}>\n`
		+ `${children}\n</Question>\n</Questionnaire>\n`;
}

test("an empty written decision round trips through MDX, Lexical and JSON", () => {
	let out = through(source());
	expect(through(out)).toBe(out);
	expect(fromElement(parsed(out)).questions[0]).toMatchObject({ response: "text", options: [] });
	let instance = editor();
	importPlan(instance, out, { registry: REGISTRY });
	let restored = editor();
	restored.setEditorState(restored.parseEditorState(JSON.stringify(instance.getEditorState())));
	expect(exportPlan(restored, { registry: REGISTRY })).toBe(out);
});

test("current and previous prose survive a round trip", () => {
	let children = '<Answer value="Start with a task; offer help when needed." />\n'
		+ '<Previous value="Begin with a tour." by="ana" at="2026-10-14T20:00:00.000Z" />';
	let out = through(source(children, "", "decided"));
	expect(through(out)).toBe(out);
	expect(fromElement(parsed(out)).questions[0]).toMatchObject({
		response: "text",
		answer: "Start with a task; offer help when needed.",
		previous: { choices: [], value: "Begin with a tour.", by: "ana" },
	});
});

test("written projections reject choices, empty answers and invalid response modes", () => {
	let option = `<Option id="${CANARY}" label="Guided task" />\n`;
	for (
		let child of [
			`<Answer value="Guided task" choices="${CANARY}" />`,
			`<Previous choices="${CANARY}" by="ana" at="2026-10-14" />`,
			'<Answer value=" " />',
			`<Answer value="${"x".repeat(4001)}" />`,
		]
	) expect(() => through(source(child))).toThrow();
	expect(() => through(source(option))).toThrow();
	expect(() => through(source().replace('multiple="false"', 'multiple="true"'))).toThrow();
	expect(() => through(source().replace('response="text"', 'response="choices"'))).toThrow();
});
