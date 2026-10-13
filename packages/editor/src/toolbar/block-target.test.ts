import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $insertList, INSERT_CHECK_LIST_COMMAND, registerList } from "@lexical/list";
import { registerRichText } from "@lexical/rich-text";
import {
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
} from "lexical";

import { COMPONENTS, exportPlan, importPlan, parse, registry, validate } from "@chopin/dialect";

import { $openBlock, CONTAINER_COMPONENTS } from "./block-target";
import { $block, convertBlock } from "./bubble";
import { insertChoices, styleChoices } from "./dock-panel";
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
	registerRichText(editor);
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

describe("columns from a nested place", () => {
	it("go after the top-level block, since the dialect allows them only there", () => {
		for (let source of [CALLOUT, TABS, LIST, COLUMNS]) {
			let editor = editorWith(source);
			run(editor, "columns");
			saved(editor);
			expect(topLevelTypes(editor).at(-1)).toBe("plan-columns");
		}
	});
});

describe("placement containers", () => {
	it("maps every dialect component that can hold a caret to its Lexical node", () => {
		let holdsBlocks = (name: string): boolean => {
			let content = COMPONENTS[name]!.content;
			return content.type === "blocks"
				|| (content.type === "components" && content.names.some(holdsBlocks));
		};
		let expected = Object.keys(COMPONENTS).filter(holdsBlocks).sort();
		expect(Object.values(CONTAINER_COMPONENTS).sort()).toEqual(expected);

		let registered = createHeadlessEditor({ nodes: registry().nodes })._nodes;
		for (let type of Object.keys(CONTAINER_COMPONENTS)) expect(registered.has(type)).toBe(true);
	});
});

describe("the phone dock's Insert panel", () => {
	/** Choose as the dock does, outside any update, and count the updates it commits. */
	function choose(editor: LexicalEditor, id: string): number {
		let commits = 0;
		let stop = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
			if (dirtyElements.size > 0 || dirtyLeaves.size > 0) commits++;
		});
		insertChoices(new Set()).find(choice => choice.id === id)!.run(editor);
		editor.update(() => {}, { discrete: true });
		stop();
		return commits;
	}

	it("keeps a code block in the callout it was chosen from", () => {
		let editor = editorWith(CALLOUT);
		choose(editor, "code");
		saved(editor);
		expect(topLevelTypes(editor)).toEqual(["plan-callout"]);
		expect(besideCaret(editor)).toEqual(["paragraph", "plan-code"]);
	});

	it("puts a block chosen in a table cell after the table", () => {
		let editor = editorWith(TABLE);
		choose(editor, "code");
		expect(saved(editor)).toContain("| one | Caret |");
		expect(topLevelTypes(editor)).toEqual(["paragraph", "table", "plan-code", "paragraph"]);
	});

	it("opens the line and inserts the block in one update, so one undo removes both", () => {
		for (let source of [CALLOUT, TABLE]) {
			expect(choose(editorWith(source), "code")).toBe(1);
		}
	});
});

describe("list conversions inside a container", () => {
	const STARTS: Record<string, string> = { paragraph: "Caret", h2: "## Caret", quote: "> Caret" };
	const PLACES: Record<string, [(text: string) => string, string]> = {
		callout: [text => CALLOUT.replace("Caret", text), "<Callout "],
		column: [text => COLUMNS.replace("Caret", text), "<Column "],
		tab: [text => TABS.replace("Caret", text), "<Tab "],
	};

	for (let [place, [wrap, tag]] of Object.entries(PLACES)) {
		for (let [from, text] of Object.entries(STARTS)) {
			it(`turns a ${from} in a ${place} into each kind of list, keeping the ${place}`, () => {
				for (let to of ["bullet", "number", "task"] as const) {
					let editor = editorWith(wrap(text));
					if (to === "task") {
						styleChoices(from as never).find(style => style.id === to)!.run(editor);
					} else convertBlock(editor, from as never, to);
					editor.update(() => {}, { discrete: true });

					let source = saved(editor);
					expect(source).toContain(tag);
					expect(topLevelTypes(editor)).toHaveLength(1);
					editor.getEditorState().read(() => {
						let caret = $getRoot().getAllTextNodes().find(node =>
							node.getTextContent() === "Caret"
						);
						expect(caret ? $block(caret) : "gone").toBe(to);
					});
				}
			});
		}
	}

	it("joins a list made beside one of the same kind", () => {
		let editor = editorWith(CALLOUT.replace("Caret", "- before\n\nCaret"));
		convertBlock(editor, "paragraph", "bullet");
		editor.update(() => {}, { discrete: true });
		expect(saved(editor)).toContain("  - before\n  - Caret\n");
	});

	it("makes each line of an imported quote its own item", () => {
		let editor = editorWith("> Caret\n");
		convertBlock(editor, "quote", "bullet");
		editor.update(() => {}, { discrete: true });
		expect(saved(editor)).toBe("- Caret\n");
		editor.getEditorState().read(() => {
			expect($block($getRoot().getAllTextNodes()[0]!)).toBe("bullet");
		});
	});
});
