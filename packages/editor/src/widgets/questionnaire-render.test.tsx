import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot } from "lexical";

import { $isQuestionnaireNode, importPlan, registry } from "@chopin/dialect";

import { renderQuestionnaire } from "./questionnaire";

import type { Questionnaire } from "@chopin/dialect";
import type { ReactElement } from "react";

const REGISTRY = registry();

test("captures a questionnaire while Lexical's read context is active", () => {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
	let rendered: ReactElement<{ value: Questionnaire }> | undefined;

	importPlan(
		editor,
		`<Questionnaire id="01K0N4TR8K7JGM4R1J7PW4R8YJ">
<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" header="Rollout" prompt="How?" multiple="false">
<Option id="01K0N4W3B7P27CBAEC7A8C8WEA" label="Canary" />
</Question>
</Questionnaire>
`,
		{ registry: REGISTRY },
	);
	editor.getEditorState().read(() => {
		let node = $getRoot().getFirstChild();
		if (!$isQuestionnaireNode(node)) throw new Error("expected questionnaire");
		rendered = renderQuestionnaire(node) as ReactElement<{ value: Questionnaire }>;
	});

	// React renders decorator output later, with no active Lexical state. The
	// renderer must therefore hold plain data, rather than the live node.
	expect(rendered?.props.value.id).toBe("01K0N4TR8K7JGM4R1J7PW4R8YJ");
});
