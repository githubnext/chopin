/**
 * Accepted comment threads.
 *
 * Atomic, for the same reason a questionnaire is: the record beside the plan
 * owns the thread, and an accepted one is frozen, so there is nothing inside
 * for two people to edit. Modelling it as a decorator keeps it movable as one
 * unit while making its contents unwritable by construction.
 *
 * Nothing renders it in the prose. The sidecar shows the card, and the passage
 * the decision concerns is marked in the text itself — this node exists so the
 * source carries the decision when read on its own.
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

export type Note = {
	/** Handle of whoever wrote it. Unverified, as everywhere else. */
	by: string;
	text: string;
};

export type Decision = {
	id: string;
	/**
	 * The prose the thread marked, as it read when the thread was accepted.
	 *
	 * A bounded locator, not the whole passage: the record holds the extent.
	 * Frozen here on purpose — the anchor keeps moving with the plan, this says
	 * what was actually being discussed.
	 */
	quote: string;
	/** Who accepted it. */
	by: string;
	/** When, ISO 8601. */
	at: string;
	notes: Note[];
};

const EMPTY: Decision = { id: "", quote: "", by: "", at: "", notes: [] };

function parse(value: unknown): Decision {
	if (!value || typeof value !== "object") return EMPTY;
	let raw = value as Partial<Decision>;
	return {
		id: typeof raw.id === "string" ? raw.id : "",
		quote: typeof raw.quote === "string" ? raw.quote : "",
		by: typeof raw.by === "string" ? raw.by : "",
		at: typeof raw.at === "string" ? raw.at : "",
		notes: Array.isArray(raw.notes) ? raw.notes : [],
	};
}

export const decisionState = createState("plan-decision", {
	parse,
	isEqual: (a: Decision, b: Decision) => JSON.stringify(a) === JSON.stringify(b),
});

type Serialized = Spread<{ planDecision: Decision }, SerializedLexicalNode>;

export class DecisionNode extends DecoratorNode<unknown> {
	static override getType(): string {
		return "plan-decision";
	}

	static override clone(node: DecisionNode): DecisionNode {
		return new DecisionNode(node.__key);
	}

	static override importJSON(serialized: Serialized): DecisionNode {
		return $createDecisionNode().updateFromJSON(serialized);
	}

	getDecision(): Decision {
		return $getState(this, decisionState);
	}

	setDecision(value: Decision): this {
		return $setState(this.getWritable(), decisionState, value);
	}

	getId(): string {
		return this.getDecision().id;
	}

	override exportJSON(): Serialized {
		return { ...super.exportJSON(), planDecision: this.getDecision() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<Serialized>): this {
		return super.updateFromJSON(serialized).setDecision(parse(serialized.planDecision));
	}

	override createDOM(): HTMLElement {
		let dom = document.createElement("div");
		dom.dataset.planDecision = this.getId();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}

	/**
	 * `DecoratorNode` defaults to inline; a decision is a block. Without this
	 * Lexical wraps it in a paragraph on insert and the node is lost.
	 */
	override isInline(): boolean {
		return false;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): unknown {
		return render(this);
	}
}

export function $createDecisionNode(value: Decision = EMPTY): DecisionNode {
	return $applyNodeReplacement(new DecisionNode().setDecision(value));
}

export function $isDecisionNode(node: LexicalNode | null | undefined): node is DecisionNode {
	return node instanceof DecisionNode;
}

// -- MDX conversion --------------------------------------------------------

/** Read a validated `<Decision>` element into plain data. */
export function fromElement(node: Jsx): Decision {
	let notes: Note[] = [];

	for (let child of node.children) {
		if (child.type !== "mdxJsxFlowElement" || child.name !== "Note") continue;
		notes.push({
			by: attribute(child, "by") ?? "",
			text: attribute(child, "text") ?? "",
		});
	}

	return {
		id: attribute(node, "id") ?? "",
		quote: attribute(node, "quote") ?? "",
		by: attribute(node, "by") ?? "",
		at: attribute(node, "at") ?? "",
		notes,
	};
}

/** Write plain data back out as a `<Decision>` element. */
export function toElement(value: Decision): MdxJsxFlowElement {
	return {
		type: "mdxJsxFlowElement",
		name: "Decision",
		attributes: identity(value.id, { quote: value.quote, by: value.by, at: value.at }),
		children: value.notes.map(note => ({
			type: "mdxJsxFlowElement" as const,
			name: "Note",
			// A projection of a thread the record owns: addressed through its
			// Decision, so it carries no identity of its own.
			attributes: attributes({ by: note.by, text: note.text }),
			children: [],
		})),
	};
}

// -- visitors --------------------------------------------------------------

/** Import the whole subtree as one atomic node; nothing inside is editable. */
export const MdastDecisionVisitor: MdastImportVisitor<MdxJsxFlowElement> = {
	testNode: isFlow("Decision"),
	visitNode({ mdastNode, lexicalParent }) {
		(lexicalParent as ElementNode).append($createDecisionNode(fromElement(mdastNode)));
	},
	priority: PRIORITY,
};

export const LexicalDecisionVisitor: LexicalExportVisitor<DecisionNode, MdxJsxFlowElement> = {
	testLexicalNode: $isDecisionNode,
	visitLexicalNode({ lexicalNode, mdastParent, actions }) {
		actions.appendToParent(mdastParent, toElement(lexicalNode.getDecision()));
	},
	priority: PRIORITY,
};
