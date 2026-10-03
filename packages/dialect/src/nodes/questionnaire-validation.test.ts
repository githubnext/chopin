import { expect, it } from "bun:test";

import { importPlan } from "../convert";

import { fromElement, toElement } from "./questionnaire";
import { BLUE, editor, ID, OPEN, parsed, REGISTRY, through } from "./questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
it("rejects malformed lifecycle attributes in MDX", () => {
	let header = `<Questionnaire id="${ID}">`;
	expect(() => through(OPEN.replace(header, `<Questionnaire id="${ID}" status="maybe">`)))
		.toThrow(/status.*must be one of/);
	expect(() => through(OPEN.replace(header, `<Questionnaire id="${ID}" thread="">`)))
		.toThrow(/thread.*cannot be empty/);
	expect(() =>
		through(OPEN.replace(
			header,
			`<Questionnaire id="${ID}" thread="${"a".repeat(201)}">`,
		))
	).toThrow(/thread.*exceeds 200 characters/);
	let previous = `<Previous choices="${BLUE}" by="ana" at="2026-09-23T17:30:00.000Z" />`;
	expect(() =>
		through(
			OPEN.replace("</Question>", `${previous.replace(`choices="${BLUE}"`, "")}\n</Question>`),
		)
	)
		.toThrow(/Previous.*requires.*choices/);
	expect(() =>
		through(OPEN.replace("</Question>", `${previous.replace('by="ana"', 'by=""')}\n</Question>`))
	)
		.toThrow(/Previous.by.*cannot be empty/);
});

it("accepts a 200-character thread ID and rejects 201 characters in MDX and Lexical", () => {
	let header = `<Questionnaire id="${ID}">`;
	let accepted = "a".repeat(200);
	let rejected = "a".repeat(201);
	let source = OPEN.replace(header, `<Questionnaire id="${ID}" thread="${accepted}">`);
	expect(through(source)).toContain(`thread="${accepted}"`);
	let instance = editor();
	importPlan(instance, OPEN, { registry: REGISTRY });
	let state = JSON.parse(JSON.stringify(instance.getEditorState())) as {
		root: { children: { planQuestionnaire: Record<string, unknown> }[] };
	};
	let value = state.root.children[0]!.planQuestionnaire;
	value.thread = accepted;
	expect(() => instance.parseEditorState(JSON.stringify(state))).not.toThrow();
	value.thread = rejected;
	expect(() => instance.parseEditorState(JSON.stringify(state))).toThrow(/thread/);
});

it("rejects malformed present lifecycle fields in Lexical JSON", () => {
	let instance = editor();
	importPlan(instance, OPEN, { registry: REGISTRY });
	let state = JSON.parse(JSON.stringify(instance.getEditorState())) as {
		root: { children: { planQuestionnaire: Record<string, unknown> }[] };
	};
	let value = state.root.children[0]!.planQuestionnaire;
	value.thread = 42;
	expect(() => instance.parseEditorState(JSON.stringify(state))).toThrow(/thread/);
	delete value.thread;
	value.status = "maybe";
	expect(() => instance.parseEditorState(JSON.stringify(state))).toThrow(/status/);
	delete value.status;
	let questions = value.questions as Record<string, unknown>[];
	questions[0]!.previous = { choices: [BLUE, "nope"], by: "ana", at: "2026-09-23" };
	expect(() => instance.parseEditorState(JSON.stringify(state))).toThrow(/previous/i);
});

it("rejects malformed present fields at the plain-data conversion boundary", () => {
	let invalidStatus = OPEN.replace(
		`<Questionnaire id="${ID}">`,
		`<Questionnaire id="${ID}" status="maybe">`,
	);
	expect(() => fromElement(parsed(invalidStatus))).toThrow(/status/);
	let emptyThread = OPEN.replace(
		`<Questionnaire id="${ID}">`,
		`<Questionnaire id="${ID}" thread="">`,
	);
	expect(() => fromElement(parsed(emptyThread))).toThrow(/thread/);
	let invalidPrevious = OPEN.replace(
		"</Question>",
		`<Previous choices="${BLUE} nope" by="ana" at="2026-09-23" />\n</Question>`,
	);
	expect(() => fromElement(parsed(invalidPrevious))).toThrow(/previous/i);
	let previous = `<Previous choices="${BLUE}" by="ana" at="2026-09-23" />`;
	expect(() =>
		fromElement(parsed(
			OPEN.replace("</Question>", `${previous}\n${previous}\n</Question>`),
		))
	).toThrow(/at most one Previous/);
	let value = fromElement(parsed(OPEN));
	expect(() => toElement({ ...value, thread: "" })).toThrow(/thread/);
	expect(() => toElement({ ...value, status: "" as "open" })).toThrow(/status/);
});
