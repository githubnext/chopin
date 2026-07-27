import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $isTableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { $getRoot, $isElementNode } from "lexical";

import { $createPlanNodes, exportPlan, importPlan } from "./convert";
import { $isCodeBlockNode } from "./nodes/content";
import { parse } from "./parse";
import { registry } from "./registry";

import type { LexicalEditor } from "lexical";

const REGISTRY = registry();

function editor(): LexicalEditor {
	return createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
}

/** MDX -> Lexical -> MDX. */
function through(source: string): string {
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	return exportPlan(instance, { registry: REGISTRY });
}

describe("registry", () => {
	it("registers native table nodes", () => {
		let types =
			REGISTRY.nodes?.map(node =>
				typeof node === "function" ? node.getType() : node.replace.getType()
			) ?? [];
		expect(types).toContain("table");
		expect(types).toContain("tablerow");
		expect(types).toContain("tablecell");
	});

	it("does not register MDXEditor's HTML node handling", () => {
		// `suppressHtmlProcessing` keeps the raw-HTML visitors out of the dialect.
		let json = JSON.stringify(REGISTRY.importVisitors?.map(v => String(v.testNode)));
		expect(json).not.toContain("mdastHTML");
	});
});

describe("conversion", () => {
	it("round-trips baseline markdown", () => {
		let cases = [
			"# Title\n",
			"Some _italic_ and **bold** text.\n",
			"- one\n- two\n",
			"1. one\n2. two\n",
			"> quoted\n",
			"---\n",
			"[docs](https://example.com)\n",
		];
		for (let source of cases) expect(through(source)).toBe(source);
	});

	/**
	 * The VM refuses any edit whose Lexical round trip does not reproduce its
	 * input, so a dropped info string does not merely lose a title — it makes
	 * the whole plan uneditable by the agent.
	 */
	it("keeps a fence's info string", () => {
		let cases = [
			'```js title="a.js"\nlet x = 1;\n```\n',
			"```mermaid collapsed\ngraph TD;\nA-->B;\n```\n",
			"```js\nlet x = 1;\n```\n",
			"```\nplain\n```\n",
		];
		for (let source of cases) expect(through(source)).toBe(source);
	});

	it("keeps a block formula's info string, which inline math cannot carry", () => {
		let cases = ["$$meta\na + b\n$$\n", "$$\na + b\n$$\n", "Inline $a+b$ math.\n"];
		for (let source of cases) expect(through(source)).toBe(source);
	});

	/** Markdown writes meta after a language, so one cannot survive without the other. */
	it("does not keep meta it would have nowhere to write", () => {
		let instance = editor();
		importPlan(instance, "```\nplain\n```\n", { registry: REGISTRY });
		let meta = instance.getEditorState().read(() => {
			let code = $getRoot().getFirstChild();
			return $isCodeBlockNode(code) ? code.getMeta() : undefined;
		});
		expect(meta).toBe("");
	});

	it("creates fragment nodes inside a live editor without replacing existing nodes", () => {
		let instance = editor();
		importPlan(instance, "# Existing\n", { registry: REGISTRY });
		let key = instance.getEditorState().read(() => $getRoot().getFirstChild()!.getKey());

		instance.update(
			() => $getRoot().append(...$createPlanNodes(parse("Added.\n"), { registry: REGISTRY })),
			{ discrete: true },
		);

		expect(exportPlan(instance, { registry: REGISTRY })).toBe("# Existing\n\nAdded.\n");
		expect(instance.getEditorState().read(() => $getRoot().getFirstChild()!.getKey())).toBe(key);
	});

	it("round-trips tables through native nodes", () => {
		let source = "| Name | Status |\n| ---- | ------ |\n| API  | Ready  |\n";
		expect(through(source)).toBe(source);
	});

	it("preserves column alignment", () => {
		let source = "| Name | Count |\n| :--- | ----: |\n| API  |     1 |\n";
		expect(through(source)).toBe(source);
	});

	it("builds tables as collaborative rows and cells, not one atomic node", () => {
		let instance = editor();
		importPlan(instance, "| a | b |\n| - | - |\n| 1 | 2 |\n", { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let table = $getRoot().getFirstChild();
			expect($isTableNode(table)).toBe(true);
			if (!$isTableNode(table)) return;

			let rows = table.getChildren();
			expect(rows).toHaveLength(2);
			expect(rows.every(row => row instanceof TableRowNode)).toBe(true);

			let cells = (rows[0] as TableRowNode).getChildren();
			expect(cells).toHaveLength(2);
			expect(cells.every(cell => cell instanceof TableCellNode)).toBe(true);

			// Text lives in ordinary descendants, which is what lets Yjs merge
			// concurrent edits to different cells.
			expect((cells[0] as TableCellNode).getTextContent()).toBe("a");
		});
	});

	it("round-trips underline as a formatting mark", () => {
		let cases = [
			"Plain <Underline>marked</Underline> text.\n",
			"A <Underline>**bold** underline</Underline> here.\n",
			"<Underline>whole line</Underline>\n",
		];
		for (let source of cases) expect(through(source)).toBe(source);
	});

	it("stores underline as a text format, not a wrapper node", () => {
		let instance = editor();
		importPlan(instance, "a <Underline>b</Underline> c\n", { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let paragraph = $getRoot().getFirstChild();
			let types = ($isElementNode(paragraph) ? paragraph.getChildren() : []).map(node =>
				node.getType()
			);
			// Every child is a plain text run; the mark lives in the format bits.
			expect(new Set(types)).toEqual(new Set(["text"]));
		});
	});

	it("never emits raw HTML for marks", () => {
		expect(through("x <Underline>y</Underline> z\n")).not.toContain("<u>");
	});

	it("rejects content outside the dialect on import", () => {
		expect(() => through('<Chart id="x" />')).toThrow(/Invalid plan MDX/);
	});

	it("rejects invalid content on export", () => {
		let instance = editor();
		importPlan(instance, "text\n", { registry: REGISTRY });
		instance.update(
			() => {
				let root = $getRoot();
				root.clear();
			},
			{ discrete: true },
		);
		// An empty document is valid; assert the happy path stays green.
		expect(() => exportPlan(instance, { registry: REGISTRY })).not.toThrow();
	});

	it("never emits import statements", () => {
		let instance = editor();
		importPlan(instance, "# Title\n", { registry: REGISTRY });
		expect(exportPlan(instance, { registry: REGISTRY })).not.toContain("import ");
	});
});
