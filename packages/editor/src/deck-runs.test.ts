import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";

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

function runs(source: string): string[][] {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError: err => {
			throw err;
		},
	});
	importPlan(editor, source, { registry: REGISTRY });
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

	it("leads with the first visible member", () => {
		expect(deckLayout([
			{ id: "a", state: "hidden" },
			{ id: "b", state: "open" },
			{ id: "c", state: "open" },
		])).toEqual({ lead: "b", members: ["b", "c"] });
	});
});
