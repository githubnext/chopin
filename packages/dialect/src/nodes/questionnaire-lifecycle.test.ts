import { expect, it } from "bun:test";
import { $getRoot } from "lexical";
import { importPlan } from "../convert";

import { $isQuestionnaireNode, cardStatus, fromElement } from "./questionnaire";
import { editor, ID, OPEN, parsed, REGISTRY, through } from "./questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
it("round-trips thread and status through MDX and Lexical", () => {
	let source = OPEN.replace(
		`<Questionnaire id="${ID}">`,
		`<Questionnaire id="${ID}" thread="thread:abc" status="discarded">`,
	);
	let out = through(source);
	expect(through(out)).toBe(out);
	expect(out).toContain('thread="thread:abc" status="discarded"');
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	instance.getEditorState().read(() => {
		let node = $getRoot().getFirstChild();
		if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
		expect(node.getQuestionnaire()).toMatchObject({
			thread: "thread:abc",
			status: "discarded",
		});
		expect(cardStatus(node.getQuestionnaire())).toBe("discarded");
	});
});

it("does not let a discarded hidden node receive keyboard selection", () => {
	let source = OPEN.replace(
		`<Questionnaire id="${ID}">`,
		`<Questionnaire id="${ID}" status="discarded">`,
	);
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	instance.getEditorState().read(() => {
		let node = $getRoot().getFirstChild();
		if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
		expect(node.isKeyboardSelectable()).toBe(false);
	});
});

it("derives status only when older documents omit it", () => {
	let open = fromElement(parsed(OPEN));
	expect(open).not.toHaveProperty("status");
	expect(open).not.toHaveProperty("thread");
	expect(cardStatus(open)).toBe("open");
	let answered = OPEN.replace("</Question>", `<Answer value="Canary" />\n</Question>`);
	expect(cardStatus(fromElement(parsed(answered)))).toBe("decided");
	for (let status of ["open", "decided", "reopened", "discarded"] as const) {
		expect(cardStatus({ ...open, status })).toBe(status);
	}
	expect(() => cardStatus({ ...open, status: "maybe" as "open" })).toThrow(/status/);
});
