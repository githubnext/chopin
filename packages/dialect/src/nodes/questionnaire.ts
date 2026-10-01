/**
 * Durable questionnaires.
 *
 * Unlike the other containers this is atomic. A questionnaire's definition is
 * fixed except for options the server appends while it is open. Its answer is
 * owned by the sidecar record; the document carries only the projection.
 * Modelling it as a decorator keeps it selectable, movable and deletable as one
 * unit while making its contents unwritable by construction.
 *
 * The `<Answer>` written into source is a projection for readability. The
 * sidecar stays authoritative; a mismatch is a server-side error, not something
 * the document can decide.
 */

import { $applyNodeReplacement, $getState, $setState, createState, DecoratorNode } from "lexical";
import { render } from "./render";
import { isFlow, PRIORITY } from "./shared";
import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type {
	ElementNode,
	LexicalNode,
	LexicalUpdateJSON,
	SerializedLexicalNode,
	Spread,
} from "lexical";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import { cardStatus, EMPTY, parse, type Questionnaire } from "./questionnaire-fields";
import { fromElement, toElement } from "./questionnaire-mdx";
export { cardStatus } from "./questionnaire-fields";
export type { CardStatus, Option, Previous, Question, Questionnaire } from "./questionnaire-fields";
export { fromElement, toElement } from "./questionnaire-mdx";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 node declarations; import/export wrappers only.

export const questionnaireState = createState("plan-questionnaire", {
	parse,
	isEqual: (a: Questionnaire, b: Questionnaire) => JSON.stringify(a) === JSON.stringify(b),
});

type Serialized = Spread<{ planQuestionnaire: Questionnaire }, SerializedLexicalNode>;

export class QuestionnaireNode extends DecoratorNode<unknown> {
	static override getType(): string {
		return "plan-questionnaire";
	}

	static override clone(node: QuestionnaireNode): QuestionnaireNode {
		return new QuestionnaireNode(node.__key);
	}

	static override importJSON(serialized: Serialized): QuestionnaireNode {
		return $createQuestionnaireNode().updateFromJSON(serialized);
	}

	getQuestionnaire(): Questionnaire {
		return $getState(this, questionnaireState);
	}

	setQuestionnaire(value: Questionnaire): this {
		return $setState(this.getWritable(), questionnaireState, value);
	}

	getId(): string {
		return this.getQuestionnaire().id;
	}

	override exportJSON(): Serialized {
		return { ...super.exportJSON(), planQuestionnaire: this.getQuestionnaire() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<Serialized>): this {
		return super.updateFromJSON(serialized).setQuestionnaire(parse(serialized.planQuestionnaire));
	}

	override createDOM(): HTMLElement {
		let dom = document.createElement("div");
		dom.dataset.planQuestionnaire = this.getId();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}

	/**
	 * `DecoratorNode` defaults to inline; a questionnaire is a block. Without
	 * this Lexical wraps it in a paragraph on insert and the node is lost.
	 */
	override isInline(): boolean {
		return false;
	}

	override isKeyboardSelectable(): boolean {
		return cardStatus(this.getQuestionnaire()) !== "discarded";
	}

	/** `@chopin/editor` renders the interactive card. */
	override decorate(): unknown {
		return render(this);
	}
}

export function $createQuestionnaireNode(value: Questionnaire = EMPTY): QuestionnaireNode {
	return $applyNodeReplacement(new QuestionnaireNode().setQuestionnaire(value));
}

export function $isQuestionnaireNode(
	node: LexicalNode | null | undefined,
): node is QuestionnaireNode {
	return node instanceof QuestionnaireNode;
}

export const MdastQuestionnaireVisitor: MdastImportVisitor<MdxJsxFlowElement> = {
	testNode: isFlow("Questionnaire"),
	visitNode({ mdastNode, lexicalParent }) {
		(lexicalParent as ElementNode).append($createQuestionnaireNode(fromElement(mdastNode)));
	},
	priority: PRIORITY,
};

export const LexicalQuestionnaireVisitor: LexicalExportVisitor<
	QuestionnaireNode,
	MdxJsxFlowElement
> = {
	testLexicalNode: $isQuestionnaireNode,
	visitLexicalNode({ lexicalNode, mdastParent, actions }) {
		actions.appendToParent(mdastParent, toElement(lexicalNode.getQuestionnaire()));
	},
	priority: PRIORITY,
};
