import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $isElementNode } from "lexical";

import { exportPlan, importPlan } from "../convert";
import { registry } from "../registry";
import { $isCodeBlockNode, $isImageNode, $isMathNode } from "./content";

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

describe("content nodes", () => {
	it("round-trips fenced code with its language", () => {
		expect(through("```ts\nlet a = 1;\n```\n")).toBe("```ts\nlet a = 1;\n```\n");
	});

	it("round-trips mermaid as a code fence", () => {
		let source = "```mermaid\ngraph TD;\nA-->B;\n```\n";
		expect(through(source)).toBe(source);
	});

	/**
	 * A patch is mostly `-` and `+` at the start of lines, which is a list
	 * everywhere else in the dialect. Inside a fence it has to survive as the
	 * bytes it was, and the fence has to stay one block rather than becoming
	 * one per hunk.
	 */
	it("round-trips a unified patch as a diff fence", () => {
		let source =
			"```diff\n--- a/main.ts\n+++ b/main.ts\n@@ -1,2 +1,2 @@\n-let a = 1;\n+let a = 2;\n"
			+ " let b = 3;\n```\n";
		expect(through(source)).toBe(source);
	});

	it("round-trips code with no language", () => {
		expect(through("```\nplain\n```\n")).toBe("```\nplain\n```\n");
	});

	it("round-trips inline and block math", () => {
		expect(through("$a + b$\n")).toBe("$a + b$\n");
		expect(through("$$\na + b\n$$\n")).toBe("$$\na + b\n$$\n");
	});

	it("round-trips images", () => {
		expect(through("![alt](https://example.com/x.png)\n"))
			.toBe("![alt](https://example.com/x.png)\n");
	});

	it("round-trips images with no alt text", () => {
		expect(through("![](https://example.com/x.png)\n")).toBe("![](https://example.com/x.png)\n");
	});

	it("round-trips footnotes preserving ULID casing", () => {
		let source = `Claim.[^${ID}]\n\n[^${ID}]: Because.\n`;
		let out = through(source);
		expect(out).toBe(source);
		// mdast lower-cases `identifier`; the authored casing must survive.
		expect(out).toContain(ID);
	});

	it("keeps code source as collaborative text children", () => {
		let instance = editor();
		importPlan(instance, "```ts\nlet a = 1;\n```\n", { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let code = $getRoot().getFirstChild();
			expect($isCodeBlockNode(code)).toBe(true);
			if (!$isElementNode(code)) return;
			// Text lives in children, not in a node property, so edits merge.
			expect(code.getChildren().map(node => node.getType())).toEqual(["text"]);
			expect(code.getTextContent()).toBe("let a = 1;");
		});
	});

	it("keeps math source as collaborative text children", () => {
		let instance = editor();
		importPlan(instance, "$$\na + b\n$$\n", { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let math = $getRoot().getFirstChild();
			expect($isMathNode(math)).toBe(true);
			if (!$isElementNode(math)) return;
			expect(math.getChildren().map(node => node.getType())).toEqual(["text"]);
			expect(math.getTextContent()).toBe("a + b");
		});
	});

	it("stores an image by its URL", () => {
		let instance = editor();
		importPlan(instance, "![alt](https://example.com/x.png)\n", { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let paragraph = $getRoot().getFirstChild();
			let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
			expect($isImageNode(image)).toBe(true);
			if (!$isImageNode(image)) return;
			expect(image.getSrc()).toBe("https://example.com/x.png");
			expect(image.getAlt()).toBe("alt");
		});
	});

	/**
	 * A URL the dialect rejects must not become a node: it would import and
	 * serialise cleanly, then fail validation on the server and cost everyone
	 * the epoch over something the author could have fixed themselves.
	 *
	 * Validation is off here because this is the path that needs the guard.
	 * Our own import rejects the source outright; MDXEditor's paste handler
	 * runs these visitors directly, and only the visitor can catch it there.
	 */
	it("keeps an unacceptable image as the text it was pasted from", () => {
		let instance = editor();
		importPlan(instance, "![alt](http://example.com/x.png)\n", {
			registry: REGISTRY,
			validate: false,
		});

		instance.getEditorState().read(() => {
			let paragraph = $getRoot().getFirstChild();
			let child = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
			expect($isImageNode(child)).toBe(false);
			expect(paragraph?.getTextContent()).toBe("![alt](http://example.com/x.png)");
		});
	});

	it("does not use @lexical/code, whose highlighting rewrites nodes as you type", () => {
		let types =
			REGISTRY.nodes?.map(node =>
				typeof node === "function" ? node.getType() : node.replace.getType()
			) ?? [];
		expect(types).toContain("plan-code");
		expect(types).not.toContain("code-highlight");
	});
});
