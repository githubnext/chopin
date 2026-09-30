import { createHeadlessEditor } from "@lexical/headless";
import { exportPlan, importPlan } from "../convert";
import { parse } from "../parse";
import { registry } from "../registry";
import type { LexicalEditor } from "lexical";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, nodes/questionnaire.test.ts helpers/data.
export const REGISTRY = registry();

export const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";

export const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";

export const CANARY = "01K0N4W3B7P27CBAEC7A8C8WEA";

export const BLUE = "01K0N4X2M5R8T3VQ7YB6ZC4DEF";

export function editor(): LexicalEditor {
	return createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
}

export function through(source: string): string {
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	return exportPlan(instance, { registry: REGISTRY });
}

export function parsed(source: string): MdxJsxFlowElement {
	let node = parse(source).children[0];
	if (node?.type !== "mdxJsxFlowElement" || node.name !== "Questionnaire") {
		throw new Error("expected questionnaire element");
	}
	return node;
}

export const OPEN = `<Questionnaire id="${ID}">\n`
	+ `<Question id="${QUESTION}" header="Rollout" `
	+ `prompt="How should we deploy?" multiple="false">\n`
	+ `<Option id="${CANARY}" label="Canary" description="Small percentage first." />\n`
	+ `<Option id="${BLUE}" label="Blue-green" />\n`
	+ `</Question>\n`
	+ `</Questionnaire>\n`;
