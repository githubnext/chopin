/**
 * The Chat draft's own Lexical nodes: a reference chip, a mention of a person, a code block and the
 * words being dictated. Each draws the classes the plain draft drew (`draft-reference`,
 * `draft-mention`, `draft-interim`), so the composer's styles and the specs that find them hold.
 */

import {
	$applyNodeReplacement,
	$createLineBreakNode,
	$createParagraphNode,
	$createTextNode,
	DecoratorNode,
	ElementNode,
	TextNode,
} from "lexical";

import type {
	DOMConversionMap,
	EditorConfig,
	LexicalNode,
	NodeKey,
	RangeSelection,
	SerializedElementNode,
	SerializedLexicalNode,
	SerializedTextNode,
	Spread,
} from "lexical";
import type { ReferencePayload } from "./draft-markdown";

type SerializedChip = Spread<{ reference: ReferencePayload }, SerializedTextNode>;

/**
 * A reference in the draft: a document, a part of this one, a file or a command, as one chip. It is
 * a token, so it is deleted whole and nothing is typed inside it.
 */
export class ChipNode extends TextNode {
	__reference: ReferencePayload;

	static override getType(): string {
		return "chat-chip";
	}

	static override clone(node: ChipNode): ChipNode {
		return new ChipNode(node.__text, node.__reference, node.__key);
	}

	static override importJSON(serialized: SerializedChip): ChipNode {
		return $createChipNode(serialized.text, serialized.reference);
	}

	constructor(text: string, reference: ReferencePayload, key?: NodeKey) {
		super(text, key);
		this.__reference = reference;
		this.__mode = 1;
	}

	override exportJSON(): SerializedChip {
		return { ...super.exportJSON(), reference: this.__reference };
	}

	getReference(): ReferencePayload {
		return this.getLatest().__reference;
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let element = super.createDOM(config);
		element.classList.add("draft-reference");
		element.dataset.reference = this.__reference.kind;
		if (this.__reference.kind === "document") {
			element.dataset.documentId = this.__reference.channelId;
		}
		return element;
	}

	override canInsertTextBefore(): boolean {
		return false;
	}

	override canInsertTextAfter(): boolean {
		return false;
	}

	override isTextEntity(): true {
		return true;
	}
}

export function $createChipNode(text: string, reference: ReferencePayload): ChipNode {
	return $applyNodeReplacement(new ChipNode(text, reference));
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
	return node instanceof ChipNode;
}

/** `@login` for a person the draft knows: drawn as a mention, and written as the words it is. */
export class MentionNode extends TextNode {
	static override getType(): string {
		return "chat-mention";
	}

	static override clone(node: MentionNode): MentionNode {
		return new MentionNode(node.__text, node.__key);
	}

	static override importJSON(serialized: SerializedTextNode): MentionNode {
		return $createMentionNode(serialized.text).updateFromJSON(serialized);
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let element = super.createDOM(config);
		element.classList.add("draft-mention");
		element.dataset.mention = this.__text.slice(1);
		return element;
	}

	override updateDOM(previous: this, dom: HTMLElement, config: EditorConfig): boolean {
		let changed = super.updateDOM(previous, dom, config);
		dom.dataset.mention = this.__text.slice(1);
		return changed;
	}

	override canInsertTextAfter(): boolean {
		return false;
	}

	override isTextEntity(): true {
		return true;
	}
}

export function $createMentionNode(text: string): MentionNode {
	return $applyNodeReplacement(new MentionNode(text));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
	return node instanceof MentionNode;
}

/** A fenced code block: lines of plain text, written between ``` fences. */
export class CodeBlockNode extends ElementNode {
	static override getType(): string {
		return "chat-code-block";
	}

	static override clone(node: CodeBlockNode): CodeBlockNode {
		return new CodeBlockNode(node.__key);
	}

	static override importJSON(serialized: SerializedElementNode): CodeBlockNode {
		return $createCodeBlockNode().updateFromJSON(serialized);
	}

	static override importDOM(): DOMConversionMap {
		return {
			pre: () => ({
				conversion: element => {
					let block = $createCodeBlockNode();
					for (
						let [index, line] of (element.textContent ?? "").replace(/\n$/, "").split("\n")
							.entries()
					) {
						if (index > 0) block.append($createLineBreakNode());
						if (line) block.append($createTextNode(line));
					}
					// The block's lines are its text; what the page drew inside them is not read again.
					return { node: block, forChild: () => null };
				},
				priority: 1,
			}),
		};
	}

	override createDOM(): HTMLElement {
		let element = document.createElement("pre");
		element.className = "draft-code-block";
		element.spellcheck = false;
		return element;
	}

	override updateDOM(): false {
		return false;
	}

	override canBeEmpty(): true {
		return true;
	}

	override isShadowRoot(): false {
		return false;
	}

	/** Backspace at its very start makes it a paragraph again, keeping its lines. */
	override collapseAtStart(_selection: RangeSelection): true {
		let paragraph = $createParagraphNode();
		paragraph.append(...this.getChildren());
		this.replace(paragraph);
		paragraph.selectStart();
		return true;
	}
}

export function $createCodeBlockNode(): CodeBlockNode {
	return $applyNodeReplacement(new CodeBlockNode());
}

export function $isCodeBlockNode(node: LexicalNode | null | undefined): node is CodeBlockNode {
	return node instanceof CodeBlockNode;
}

type SerializedInterim = Spread<{ text: string }, SerializedLexicalNode>;

/**
 * What is being dictated and not yet settled, drawn beside the caret from `data-interim`. It is no
 * part of the draft: it has no text, is never written, and is put in and taken out outside history.
 */
export class InterimNode extends DecoratorNode<null> {
	__words: string;

	static override getType(): string {
		return "chat-interim";
	}

	static override clone(node: InterimNode): InterimNode {
		return new InterimNode(node.__words, node.__key);
	}

	static override importJSON(serialized: SerializedInterim): InterimNode {
		return new InterimNode(serialized.text);
	}

	constructor(words: string, key?: NodeKey) {
		super(key);
		this.__words = words;
	}

	override exportJSON(): SerializedInterim {
		return { ...super.exportJSON(), text: this.__words };
	}

	override createDOM(): HTMLElement {
		let element = document.createElement("span");
		element.className = "draft-interim";
		element.contentEditable = "false";
		element.dataset.interim = this.__words;
		return element;
	}

	override updateDOM(previous: this, dom: HTMLElement): false {
		if (previous.__words !== this.__words) dom.dataset.interim = this.__words;
		return false;
	}

	override getTextContent(): string {
		return "";
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): false {
		return false;
	}

	override decorate(): null {
		return null;
	}
}

export function $isInterimNode(node: LexicalNode | null | undefined): node is InterimNode {
	return node instanceof InterimNode;
}
