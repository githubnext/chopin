import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection } from "lexical";

import { $createCodeBlockNode, registry } from "@chopin/dialect";

import { $leaveCode, fenceOf } from "./code-keys";

const REGISTRY = registry();

test("a typed fence names its language, in lower case, or none", () => {
	expect(fenceOf("```")).toBe("");
	expect(fenceOf("```Python")).toBe("python");
	expect(fenceOf("```c++")).toBe("c++");
	expect(fenceOf("``")).toBeUndefined();
	expect(fenceOf("```ts x")).toBeUndefined();
	expect(fenceOf("say ```")).toBeUndefined();
});

function leave(build: () => void) {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
	let out = { types: [] as string[], at: "" };
	editor.update(() => {
		build();
		let code = $getRoot().getChildren().find(node => node.getType() === "plan-code")!;
		$leaveCode(code as ReturnType<typeof $createCodeBlockNode>);
	}, { discrete: true });
	editor.getEditorState().read(() => {
		out.types = $getRoot().getChildren().map(node => node.getType());
		out.at = $getSelection()?.getNodes()[0]?.getTopLevelElement()?.getTextContent() ?? "";
	});
	return out;
}

test("leaving a code block goes to the start of the block after it", () => {
	let result = leave(() => {
		$getRoot().append(
			$createCodeBlockNode("ts", "a();"),
			$createParagraphNode().append($createTextNode("After.")),
		);
	});
	expect(result.types).toEqual(["plan-code", "paragraph"]);
	expect(result.at).toBe("After.");
});

test("leaving the last block makes a paragraph to land in", () => {
	let result = leave(() => {
		$getRoot().append($createCodeBlockNode("ts", "a();"));
	});
	expect(result.types).toEqual(["plan-code", "paragraph"]);
	expect(result.at).toBe("");
});
