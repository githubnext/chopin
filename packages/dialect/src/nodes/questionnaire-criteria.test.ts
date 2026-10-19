import { expect, it } from "bun:test";
import { $getRoot } from "lexical";
import { exportPlan, importPlan } from "../convert";
import { $isQuestionnaireNode } from "./questionnaire";
import { BLUE, CANARY, editor, ID, OPEN, QUESTION, REGISTRY, through } from "./questionnaire.test-fixtures";

const SPEED = "01K0N5A1B2C3D4E5F6G7H8J9KM";
const COST = "01K0N5A1B2C3D4E5F6G7H8J9KN";

const CRITERIA = `<Criterion id="${SPEED}" label="New device" />\n`
	+ `<Criterion id="${COST}" label="No new storage" />\n`;

const ASKED = OPEN.replace("</Question>", `${CRITERIA}</Question>`);
const SETTLED = ASKED
	.replace(`<Questionnaire id="${ID}">`, `<Questionnaire id="${ID}" status="decided" by="ana" at="2026-09-23T17:30:00.000Z">`)
	.replace(
		"</Question>",
		`<Answer value="Canary" choices="${CANARY}" marks="${CANARY}/${SPEED}:yes ${CANARY}/${COST}:partly ${BLUE}/${SPEED}:no" />\n</Question>`,
	);

function problems(source: string): string {
	try {
		through(source);
		return "";
	} catch (err) {
		return (err as Error).message;
	}
}

it("round-trips criteria through MDX and Lexical JSON", () => {
	let out = through(ASKED);
	expect(out).toContain(`<Criterion id="${SPEED}" label="New device" />`);
	expect(through(out)).toBe(out);
	let instance = editor();
	importPlan(instance, ASKED, { registry: REGISTRY });
	let restored = editor();
	restored.setEditorState(restored.parseEditorState(JSON.stringify(instance.getEditorState())));
	expect(exportPlan(restored, { registry: REGISTRY })).toBe(out);
	restored.getEditorState().read(() => {
		let node = $getRoot().getFirstChild();
		if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
		expect(node.getQuestionnaire().questions[0]!.criteria).toEqual([
			{ id: SPEED, label: "New device" },
			{ id: COST, label: "No new storage" },
		]);
	});
});

it("round-trips a settled answer's marks", () => {
	let out = through(SETTLED);
	expect(out).toContain(`marks="${CANARY}/${SPEED}:yes`);
	expect(through(out)).toBe(out);
	let instance = editor();
	importPlan(instance, SETTLED, { registry: REGISTRY });
	instance.getEditorState().read(() => {
		let node = $getRoot().getFirstChild();
		if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
		expect(node.getQuestionnaire().questions[0]!.marks).toEqual({
			[`${CANARY}/${SPEED}`]: "yes",
			[`${CANARY}/${COST}`]: "partly",
			[`${BLUE}/${SPEED}`]: "no",
		});
	});
});

it("leaves questionnaires without criteria unchanged", () => {
	expect(through(OPEN)).not.toContain("Criterion");
	expect(problems(OPEN)).toBe("");
	expect(problems(ASKED)).toBe("");
	expect(problems(SETTLED)).toBe("");
});

it("rejects invalid criteria and marks", () => {
	expect(problems(ASKED.replace(`id="${COST}"`, `id="${SPEED}"`))).toContain("distinct criteria");
	expect(problems(SETTLED.replace(`/${COST}:partly`, `/${COST}:maybe`))).toContain("Answer marks");
	expect(problems(SETTLED.replace(`${BLUE}/${SPEED}:no`, `${BLUE}/${QUESTION}:no`))).toContain("Answer marks");
	expect(problems(OPEN.replace("</Question>", `<Answer value="Canary" marks="${CANARY}/${SPEED}:yes" />\n</Question>`)))
		.toContain("Answer marks");
});
