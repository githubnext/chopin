import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $getRoot } from "lexical";

import { importPlan, registry } from "@chopin/dialect";

import { $collectDecisionRuns, deckLayout } from "./deck-runs";

const REGISTRY = registry();

function card(n: number) {
	return `<Questionnaire id="01K0N4TR8K7JGM4R1J7PW4R8Y${n}">\n`
		+ `<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3B${n}" header="H${n}" prompt="Q${n}?" multiple="false">\n`
		+ `<Option id="01K0N4W3B7P27CBAEC7A8C8WE${n}" label="O${n}" />\n`
		+ `</Question>\n</Questionnaire>\n`;
}
let id = (n: number) => `01K0N4TR8K7JGM4R1J7PW4R8Y${n}`;

function runs(source: string, edit?: () => void): string[][] {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError: err => {
			throw err;
		},
	});
	importPlan(editor, source, { registry: REGISTRY });
	if (edit) editor.update(edit, { discrete: true });
	let value: string[][] = [];
	editor.getEditorState().read(() => {
		value = $collectDecisionRuns();
	});
	return value;
}

describe("decision runs", () => {
	it("groups consecutive cards", () => {
		expect(runs(`Intro.\n\n${card(1)}\n${card(2)}\n${card(3)}\nOutro.\n`))
			.toEqual([[id(1), id(2), id(3)]]);
	});

	it("does not group cards separated by prose", () => {
		expect(runs(`${card(1)}\nBetween.\n\n${card(2)}`)).toEqual([]);
	});

	it("finds separate runs", () => {
		expect(runs(`${card(1)}\n${card(2)}\nBetween.\n\n${card(3)}\n${card(4)}`))
			.toEqual([[id(1), id(2)], [id(3), id(4)]]);
	});

	it("groups cards separated only by an empty caret paragraph", () => {
		let source = `Intro.\n\n${card(1)}\n${card(2)}`;
		let inserted = runs(source, () => {
			let [, first] = $getRoot().getChildren();
			first!.insertAfter($createParagraphNode());
		});
		expect(inserted).toEqual([[id(1), id(2)]]);
	});

	it("counts a multi-question card as one member", () => {
		let multi = `<Questionnaire id="${id(1)}">\n`
			+ `<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3C1" header="A" prompt="A?" multiple="false">\n`
			+ `<Option id="01K0N4W3B7P27CBAEC7A8C8WF1" label="A1" />\n</Question>\n`
			+ `<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3C2" header="B" prompt="B?" multiple="false">\n`
			+ `<Option id="01K0N4W3B7P27CBAEC7A8C8WF2" label="B1" />\n</Question>\n`
			+ `</Questionnaire>\n`;
		expect(runs(`${multi}\n${card(2)}`)).toEqual([[id(1), id(2)]]);
	});

	it("ignores a lone card", () => {
		expect(runs(`Intro.\n\n${card(1)}`)).toEqual([]);
	});
});

describe("deck layout", () => {
	it("needs two visible members and one open member", () => {
		expect(deckLayout([{ id: "a", state: "open" }, { id: "b", state: "hidden" }]))
			.toBeUndefined();
		expect(deckLayout([{ id: "a", state: "settled" }, { id: "b", state: "settled" }]))
			.toBeUndefined();
		expect(deckLayout([{ id: "a", state: "settled" }, { id: "b", state: "open" }]))
			.toEqual({ lead: "a", members: ["a", "b"] });
	});

	it("stays hosted by the run's first node while it is hidden", () => {
		expect(deckLayout([
			{ id: "a", state: "hidden" },
			{ id: "b", state: "open" },
			{ id: "c", state: "open" },
		])).toEqual({ lead: "a", members: ["b", "c"] });
	});
});
