import { $applyNodeReplacement, $getState, $setState, createState, DecoratorNode } from "lexical";
import { idState } from "./identity";
import { render } from "./render";
import { attribute, identity, isFlow, PRIORITY } from "./shared";
import type { LexicalNode, LexicalUpdateJSON, SerializedLexicalNode, Spread } from "lexical";
import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";

let experimentState = createState("experiment-reference", {
	parse: (value: unknown) => typeof value === "string" ? value : "",
});
let viewState = createState("experiment-view", {
	parse: (value: unknown) => typeof value === "string" ? value : "",
});
let decisionState = createState("experiment-decision", {
	parse: (value: unknown) => typeof value === "string" ? value : "",
});
type Serialized = Spread<
	{ planId: string; experiment: string; view: string; decision: string },
	SerializedLexicalNode
>;

export class ExperimentNode extends DecoratorNode<unknown> {
	static override getType() {
		return "plan-experiment";
	}
	static override clone(node: ExperimentNode) {
		return new ExperimentNode(node.__key);
	}
	static override importJSON(serialized: Serialized) {
		return $createExperimentNode().updateFromJSON(serialized);
	}
	getId() {
		return $getState(this, idState);
	}
	getExperiment() {
		return $getState(this, experimentState);
	}
	getView() {
		return $getState(this, viewState);
	}
	getDecision() {
		return $getState(this, decisionState);
	}
	setReference(id: string, experiment: string, view: string, decision: string) {
		let node = this.getWritable();
		$setState(node, idState, id);
		$setState(node, experimentState, experiment);
		$setState(node, viewState, view);
		$setState(node, decisionState, decision);
		return node;
	}
	override exportJSON(): Serialized {
		return {
			...super.exportJSON(),
			planId: this.getId(),
			experiment: this.getExperiment(),
			view: this.getView(),
			decision: this.getDecision(),
		};
	}
	override updateFromJSON(value: LexicalUpdateJSON<Serialized>) {
		return super.updateFromJSON(value).setReference(
			value.planId,
			value.experiment,
			value.view,
			value.decision,
		);
	}
	override createDOM() {
		let dom = document.createElement("div");
		dom.dataset.planExperiment = this.getId();
		return dom;
	}
	override updateDOM() {
		return false;
	}
	override isInline() {
		return false;
	}
	override isKeyboardSelectable() {
		return true;
	}
	override decorate() {
		return render(this);
	}
}
export function $createExperimentNode(id = "", experiment = "", view = "", decision = "") {
	return $applyNodeReplacement(new ExperimentNode()).setReference(id, experiment, view, decision);
}
export function $isExperimentNode(node: LexicalNode | null | undefined): node is ExperimentNode {
	return node instanceof ExperimentNode;
}

export const MdastExperimentVisitor: MdastImportVisitor<MdxJsxFlowElement> = {
	testNode: isFlow("Experiment"),
	priority: PRIORITY,
	visitNode({ mdastNode, actions }) {
		actions.addAndStepInto(
			$createExperimentNode(
				attribute(mdastNode, "id") ?? "",
				attribute(mdastNode, "experiment") ?? "",
				attribute(mdastNode, "view") ?? "",
				attribute(mdastNode, "decision") ?? "",
			),
		);
	},
};
export const LexicalExperimentVisitor: LexicalExportVisitor<ExperimentNode, MdxJsxFlowElement> = {
	testLexicalNode: $isExperimentNode,
	priority: PRIORITY,
	visitLexicalNode({ lexicalNode: node, actions }) {
		actions.addAndStepInto("mdxJsxFlowElement", {
			name: "Experiment",
			attributes: identity(node.getId(), {
				experiment: node.getExperiment(),
				view: node.getView(),
				...(node.getDecision() ? { decision: node.getDecision() } : {}),
			}),
		});
	},
};
