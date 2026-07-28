import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $isElementNode } from "lexical";

import { exportPlan, importPlan } from "../convert";
import { registry } from "../registry";
import { $isDecisionNode } from "./decision";

import type { LexicalEditor } from "lexical";

const REGISTRY = registry();

const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";

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

const ACCEPTED = `<Decision id="${ID}" quote="The renderer caches tiles for 60 seconds." `
	+ `by="krzysztof" at="2026-07-28T10:14:00Z">\n`
	+ `<Note by="krzysztof" text="60s is too long, the data changes every 10s." />\n`
	+ `<Note by="ana" text="Agreed, and it should be configurable." />\n`
	+ `</Decision>\n`;

describe("decision", () => {
	it("round-trips an accepted thread", () => {
		let out = through(ACCEPTED);
		expect(through(out)).toBe(out);
		expect(out).toContain(`id="${ID}"`);
		expect(out).toContain('by="krzysztof"');
		expect(out).toContain('at="2026-07-28T10:14:00Z"');
		expect(out).toContain('quote="The renderer caches tiles for 60 seconds."');
	});

	it("keeps the thread in the order it was said", () => {
		let instance = editor();
		importPlan(instance, ACCEPTED, { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let node = $getRoot().getFirstChild();
			if (!$isDecisionNode(node)) throw new Error("expected decision");
			expect(node.getDecision().notes.map(note => note.by)).toEqual(["krzysztof", "ana"]);
		});
	});

	it("gives a note no identity of its own", () => {
		let note = through(ACCEPTED).split("\n").find(line => line.includes("<Note"));
		// It is addressed through its Decision, exactly as an Answer is
		// addressed through its Question.
		expect(note).not.toContain("id=");
	});

	it("imports as one atomic node", () => {
		let instance = editor();
		importPlan(instance, ACCEPTED, { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let node = $getRoot().getFirstChild();
			expect($isDecisionNode(node)).toBe(true);
			if (!$isDecisionNode(node)) return;

			// A decorator, not an element: an accepted thread is frozen, so
			// there is no editable subtree inside it.
			expect($isElementNode(node)).toBe(false);
			expect(node.getDecision().id).toBe(ID);
		});
	});

	it("carries a note through unchanged when it spans lines and quotes things", () => {
		// The text is an attribute rather than children precisely so this
		// survives: a flow component's children parse as blocks, and prose
		// written between the tags would come back wrapped in a paragraph.
		let text = 'line one\nline two\n\nand "quoted" & <angled>';
		let source = `<Decision id="${ID}" quote="q" by="ana" at="2026-07-28T10:14:00Z">\n`
			+ `<Note by="ana" text="${text.replaceAll('"', "&#x22;")}" />\n`
			+ `</Decision>\n`;

		let instance = editor();
		importPlan(instance, source, { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let node = $getRoot().getFirstChild();
			if (!$isDecisionNode(node)) throw new Error("expected decision");
			expect(node.getDecision().notes[0]!.text).toBe(text);
		});

		expect(through(through(source))).toBe(through(source));
	});
});
