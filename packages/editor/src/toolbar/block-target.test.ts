import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $insertList, INSERT_CHECK_LIST_COMMAND, registerList } from "@lexical/list";
import {
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
} from "lexical";

import { exportPlan, importPlan, parse, registry, validate } from "@chopin/dialect";

import { $openBlock } from "./block-target";
import { availableCommands } from "./slash";

import type { LexicalEditor } from "lexical";

const IDS = [
	"01K0N4W3B7P27CBAEC7A8C8WEA",
	"01K0N4W3B7P27CBAEC7A8C8WEB",
	"01K0N4W3B7P27CBAEC7A8C8WEC",
];

const TABLE = "Intro.\n\n| A | B |\n| - | - |\n| one | Caret |\n\nOutro.\n";
const LIST = "- first\n- Caret\n- last\n";
const COLUMNS = `<Columns id="${IDS[0]}">\n<Column id="${IDS[1]}">\n\nCaret\n\n</Column>\n`
	+ `<Column id="${IDS[2]}">\n\nSecond.\n\n</Column>\n</Columns>\n`;
const CALLOUT = `<Callout id="${IDS[0]}" type="note">\n\nCaret\n\n</Callout>\n`;
const TABS = `<Tabs id="${IDS[0]}">\n<Tab id="${
	IDS[1]
}" label="One">\n\nCaret\n\n</Tab>\n</Tabs>\n`;

/** Every slash insert, and the top-level node type each one leaves behind. */
const BLOCKS: Record<string, string> = {
	callout: "plan-callout",
	table: "table",
	columns: "plan-columns",
	tasks: "list",
	code: "plan-code",
	mermaid: "plan-code",
	math: "plan-math",
	tabs: "plan-tabs",
	diff: "plan-code",
};

function editorWith(source: string): LexicalEditor {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	registerList(editor);
	// The browser registers this with the check-list plugin, which needs a DOM root.
	editor.registerCommand(INSERT_CHECK_LIST_COMMAND, () => {
		$insertList("check");
		return true;
	}, COMMAND_PRIORITY_LOW);
	importPlan(editor, source);
	editor.update(() => {
		$getRoot().getAllTextNodes().find(node => node.getTextContent() === "Caret")?.selectEnd();
	}, { discrete: true });
	return editor;
}

function run(editor: LexicalEditor, id: string): void {
	let command = availableCommands("").find(command => command.id === id);
	if (command?.kind !== "insert") throw new Error(`${id} must be an insert command`);
	editor.update(() => command.run(editor), { discrete: true });
}

/** The exported document, after checking it is valid and survives a round trip. */
function saved(editor: LexicalEditor): string {
	let source = exportPlan(editor);
	expect(validate(parse(source))).toEqual({ ok: true });
	let again = createHeadlessEditor({ nodes: registry().nodes });
	importPlan(again, source);
	expect(exportPlan(again)).toBe(source);
	return source;
}

function topLevelTypes(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() => $getRoot().getChildren().map(node => node.getType()));
}

/** The blocks beside the caret's paragraph, inside whatever holds it. */
function besideCaret(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() => {
		let caret = $getRoot().getAllTextNodes().find(node => node.getTextContent() === "Caret");
		let holder = caret?.getParent()?.getParent();
		return $isElementNode(holder) ? holder.getChildren().map(child => child.getType()) : [];
	});
}

describe("slash blocks from a table cell", () => {
	for (let [id, type] of Object.entries(BLOCKS)) {
		it(`puts ${id} after the whole table, leaving the cell as text`, () => {
			let editor = editorWith(TABLE);
			run(editor, id);
			let source = saved(editor);

			expect(topLevelTypes(editor)).toEqual(["paragraph", "table", type, "paragraph"]);
			expect(source).toContain("| one | Caret |");
		});
	}

	it("keeps an image, which is inline, in the cell", () => {
		let prompt = globalThis.window;
		globalThis.window = { prompt: () => "https://example.com/a.png", alert() {} } as never;
		try {
			let editor = editorWith(TABLE);
			run(editor, "image");
			expect(saved(editor)).toContain("| one | Caret![](https://example.com/a.png) |");
		} finally {
			globalThis.window = prompt;
		}
	});

	it("opens a typed-for slash after the table rather than inside its cell", () => {
		let editor = editorWith(TABLE);
		editor.update($openBlock, { discrete: true });
		expect(topLevelTypes(editor)).toEqual(["paragraph", "table", "paragraph", "paragraph"]);
		editor.getEditorState().read(() => {
			let selection = $getSelection();
			expect($isRangeSelection(selection)).toBe(true);
			if (!$isRangeSelection(selection)) return;
			expect(selection.anchor.key).toBe($getRoot().getChildAtIndex(2)!.getKey());
		});
	});
});

describe("slash blocks from other nested places", () => {
	for (let id of Object.keys(BLOCKS)) {
		for (let [place, source] of Object.entries({ LIST, COLUMNS, CALLOUT, TABS })) {
			it(`leaves a valid document for ${id} in ${place.toLowerCase()}`, () => {
				let editor = editorWith(source);
				run(editor, id);
				saved(editor);
			});
		}
	}

	it("moves a callout out of a callout or column, which forbid one", () => {
		for (let source of [CALLOUT, COLUMNS]) {
			let editor = editorWith(source);
			run(editor, "callout");
			expect(topLevelTypes(editor).at(-1)).toBe("plan-callout");
			expect(saved(editor)).toContain("Caret");
		}
	});

	it("moves tabs out of tabs or a column, which forbid them", () => {
		for (let source of [TABS, COLUMNS]) {
			let editor = editorWith(source);
			run(editor, "tabs");
			expect(topLevelTypes(editor)).toHaveLength(2);
			expect(topLevelTypes(editor).at(-1)).toBe("plan-tabs");
		}
	});

	it("keeps a table, tabs or a task list inside a container that allows them", () => {
		let cases: [string, string, string[]][] = [
			["table", CALLOUT, ["paragraph", "table"]],
			["table", COLUMNS, ["paragraph", "table"]],
			["table", TABS, ["paragraph", "table"]],
			["tabs", CALLOUT, ["paragraph", "plan-tabs"]],
		];
		for (let [id, source, inside] of cases) {
			let editor = editorWith(source);
			run(editor, id);
			saved(editor);
			expect(topLevelTypes(editor)).toHaveLength(1);
			expect(besideCaret(editor)).toEqual(inside);
		}
		for (let source of [CALLOUT, COLUMNS, TABS]) {
			let editor = editorWith(source);
			run(editor, "tasks");
			expect(saved(editor)).toContain("- [ ] Caret");
			expect(topLevelTypes(editor)).toHaveLength(1);
		}
	});
});
