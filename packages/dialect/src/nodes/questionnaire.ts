/**
 * Durable questionnaires.
 *
 * Unlike the other containers this is atomic. A questionnaire's definition is
 * immutable once created, and its answer is owned by the sidecar record rather
 * than by the document, so there is nothing inside it for two people to edit
 * concurrently. Modelling it as a decorator keeps it selectable, movable and
 * deletable as one unit while making its contents unwritable by construction.
 *
 * The `<Answer>` written into source is a projection for readability. The
 * sidecar stays authoritative; a mismatch is a server-side error, not something
 * the document can decide.
 */

import { $applyNodeReplacement, $getState, $setState, createState, DecoratorNode } from "lexical";

import { render } from "./render";
import { attribute, attributes, identity, isFlow, PRIORITY } from "./shared";

import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type {
	ElementNode,
	LexicalNode,
	LexicalUpdateJSON,
	SerializedLexicalNode,
	Spread,
} from "lexical";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type { Jsx } from "./shared";

export type Option = {
	id: string;
	label: string;
	description?: string;
};

export type Question = {
	id: string;
	header: string;
	prompt: string;
	multiple: boolean;
	options: Option[];
	/** Projection of the resolved answer, when there is one. */
	answer?: string;
};

export type Questionnaire = {
	id: string;
	questions: Question[];
	/**
	 * Who settled it, and when.
	 *
	 * On the questionnaire rather than on each answer: it resolves as a unit,
	 * so this is one fact about one moment. Absent until it is answered, and
	 * absent for good on one answered before this was written down.
	 */
	by?: string;
	/** ISO 8601. */
	at?: string;
};

const EMPTY: Questionnaire = { id: "", questions: [] };

function parse(value: unknown): Questionnaire {
	if (!value || typeof value !== "object") return EMPTY;
	let raw = value as Partial<Questionnaire>;
	return {
		id: typeof raw.id === "string" ? raw.id : "",
		questions: Array.isArray(raw.questions) ? raw.questions : [],
		...(typeof raw.by === "string" ? { by: raw.by } : {}),
		...(typeof raw.at === "string" ? { at: raw.at } : {}),
	};
}

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
		return true;
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

// -- MDX conversion --------------------------------------------------------

function elements(node: Jsx, name: string): MdxJsxFlowElement[] {
	let out: MdxJsxFlowElement[] = [];
	for (let child of node.children) {
		if (child.type === "mdxJsxFlowElement" && child.name === name) out.push(child);
	}
	return out;
}

/** Read a validated `<Questionnaire>` element into plain data. */
export function fromElement(node: Jsx): Questionnaire {
	let questions: Question[] = [];

	for (let element of elements(node, "Question")) {
		let options: Option[] = [];
		for (let source of elements(element, "Option")) {
			let option: Option = {
				id: attribute(source, "id") ?? "",
				label: attribute(source, "label") ?? "",
			};
			let description = attribute(source, "description");
			if (description) option.description = description;
			options.push(option);
		}

		let question: Question = {
			id: attribute(element, "id") ?? "",
			header: attribute(element, "header") ?? "",
			prompt: attribute(element, "prompt") ?? "",
			multiple: attribute(element, "multiple") === "true",
			options,
		};

		let answer = elements(element, "Answer")[0];
		if (answer) question.answer = attribute(answer, "value") ?? "";

		questions.push(question);
	}

	let by = attribute(node, "by");
	let at = attribute(node, "at");

	return {
		id: attribute(node, "id") ?? "",
		questions,
		...(by ? { by } : {}),
		...(at ? { at } : {}),
	};
}

/** Write plain data back out as a `<Questionnaire>` element. */
export function toElement(value: Questionnaire): MdxJsxFlowElement {
	return {
		type: "mdxJsxFlowElement",
		name: "Questionnaire",
		attributes: identity(value.id, { by: value.by, at: value.at }),
		children: value.questions.map(question => ({
			type: "mdxJsxFlowElement",
			name: "Question",
			attributes: identity(question.id, {
				header: question.header,
				prompt: question.prompt,
				multiple: String(question.multiple),
			}),
			children: [
				...question.options.map(option => ({
					type: "mdxJsxFlowElement" as const,
					name: "Option",
					attributes: identity(option.id, { label: option.label, description: option.description }),
					children: [],
				})),
				// A projection of sidecar state: addressed through its Question,
				// so it carries no identity of its own.
				...(question.answer === undefined ? [] : [{
					type: "mdxJsxFlowElement" as const,
					name: "Answer",
					attributes: attributes({ value: question.answer }),
					children: [],
				}]),
			],
		})),
	};
}

// -- visitors --------------------------------------------------------------

/** Import the whole subtree as one atomic node; nothing inside is editable. */
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
