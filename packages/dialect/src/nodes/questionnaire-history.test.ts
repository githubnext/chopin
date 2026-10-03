import { expect, it } from "bun:test";
import { $getRoot } from "lexical";
import { exportPlan, importPlan } from "../convert";
import * as limits from "../limits";
import { ulid } from "../ulid";
import { $isQuestionnaireNode } from "./questionnaire";
import {
	BLUE,
	CANARY,
	editor,
	ID,
	OPEN,
	QUESTION,
	REGISTRY,
	through,
} from "./questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
it("round-trips a previous decision through MDX and Lexical JSON", () => {
	let source = OPEN
		.replace(
			`<Questionnaire id="${ID}">`,
			`<Questionnaire id="${ID}" thread="thread:abc" status="reopened">`,
		)
		.replace(
			"</Question>",
			`<Previous choices="${BLUE}" by="ana" at="2026-09-23T17:30:00.000Z" />\n</Question>`,
		);
	let out = through(source);
	expect(through(out)).toBe(out);
	expect(out).toContain(
		`<Previous choices="${BLUE}" by="ana" at="2026-09-23T17:30:00.000Z" />`,
	);
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	let json = JSON.stringify(instance.getEditorState());
	let restored = editor();
	restored.setEditorState(restored.parseEditorState(json));
	expect(exportPlan(restored, { registry: REGISTRY })).toBe(out);
	restored.getEditorState().read(() => {
		let node = $getRoot().getFirstChild();
		if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
		expect(node.getQuestionnaire().questions[0]!.previous).toEqual({
			choices: [BLUE],
			by: "ana",
			at: "2026-09-23T17:30:00.000Z",
		});
	});
});

it("round-trips a previous answer without inventing an option choice", () => {
	let source = OPEN.replace(
		"</Question>",
		`<Previous value="Use an external provider" by="ana" at="2026-09-23T17:30:00.000Z" />\n</Question>`,
	);
	let out = through(source);
	expect(out).toContain('<Previous value="Use an external provider" by="ana"');
	expect(out).not.toContain("<Previous choices=");
	expect(through(out)).toBe(out);
});

it("rejects a previous answer with neither or both representations", () => {
	let previous = (attributes: string) =>
		OPEN.replace(
			"</Question>",
			`<Previous ${attributes} by="ana" at="2026-09-23" />\n</Question>`,
		);
	expect(() => through(previous(""))).toThrow();
	expect(() => through(previous(`choices="${BLUE}" value="Text"`))).toThrow();
	expect(() => through(previous('value=""'))).toThrow();
	expect(() => through(previous(`value="${"x".repeat(4001)}"`))).toThrow();
});

it("rejects unknown, repeated, and excess previous choice identifiers", () => {
	let previous = (choices: string) =>
		OPEN.replace(
			"</Question>",
			`<Previous choices="${choices}" by="ana" at="2026-09-23T17:30:00.000Z" />\n</Question>`,
		);
	expect(() => through(previous(`${BLUE} nope`))).toThrow(/Previous choices must name options/);
	expect(() => through(previous(`${BLUE} ${BLUE}`))).toThrow(/Previous choices cannot repeat/);
	expect(() => through(previous(`${CANARY} ${BLUE}`))).toThrow(/accepts one choice/);
	let ids = Array.from({ length: limits.MAX_OPTIONS + 1 }, () => ulid());
	let source = `<Questionnaire id="${ID}">\n`
		+ `<Question id="${QUESTION}" header="Rollout" prompt="How?" multiple="true">\n`
		+ ids.map(id => `<Option id="${id}" label="Choice" />\n`).join("")
		+ `<Previous choices="${ids.join(" ")}" by="ana" at="2026-09-23T17:30:00.000Z" />\n`
		+ `</Question>\n</Questionnaire>\n`;
	expect(() => through(source)).toThrow(/Previous accepts at most 20 choices/);
});

it("rejects multiple previous decisions in one question", () => {
	let previous = `<Previous choices="${BLUE}" by="ana" at="2026-09-23T17:30:00.000Z" />`;
	let source = OPEN.replace("</Question>", `${previous}\n${previous}\n</Question>`);
	expect(() => through(source)).toThrow(/at most one Previous/);
});
