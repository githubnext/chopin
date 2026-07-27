/**
 * Code, math, images and footnotes.
 *
 * Code and math hold their source as ordinary Lexical text children rather than
 * as a node property, so two people editing the same block merge per character
 * instead of overwriting each other. Syntax highlighting and KaTeX rendering are
 * presentation, applied by `@chopin/editor` over this model — deliberately not by
 * rewriting child nodes, which would churn the CRDT on every keystroke.
 *
 * Images and footnote references are genuinely atomic, so they are decorators.
 * `decorate()` returns null here; the UI package supplies the rendering.
 */

import {
	$applyNodeReplacement,
	$createTextNode,
	$getState,
	$setState,
	createState,
	DecoratorNode,
	ElementNode,
	setDOMUnmanaged,
} from "lexical";

import { render } from "./render";

import type {
	EditorConfig,
	ElementDOMSlot,
	LexicalNode,
	LexicalUpdateJSON,
	SerializedElementNode,
	SerializedLexicalNode,
	Spread,
} from "lexical";

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function flag(value: unknown): boolean {
	return value === true;
}

export const languageState = createState("plan-language", { parse: text });
/**
 * The rest of a fence's info string, after the language.
 *
 * Nothing reads it. It is carried so that a fence written as
 * ```` ```js title="a.js" ```` survives being opened and saved: dropping it
 * would rewrite the author's source, and the server rejects any edit whose Lexical
 * round trip does not reproduce its input.
 */
export const metaState = createState("plan-meta", { parse: text });
export const inlineState = createState("plan-inline", { parse: flag });
export const srcState = createState("plan-src", { parse: text });
export const altState = createState("plan-alt", { parse: text });
export const identifierState = createState("plan-identifier", { parse: text });

// -- code ------------------------------------------------------------------

type SerializedCode = Spread<{ planLanguage: string; planMeta: string }, SerializedElementNode>;

/**
 * A fenced code block.
 *
 * Ace does not use `@lexical/code`: its highlighting rewrites child nodes as you
 * type, which is exactly the mutation pattern to avoid in a shared document.
 */
export class CodeBlockNode extends ElementNode {
	static override getType(): string {
		return "plan-code";
	}

	static override clone(node: CodeBlockNode): CodeBlockNode {
		return new CodeBlockNode(node.__key);
	}

	static override importJSON(serialized: SerializedCode): CodeBlockNode {
		return $createCodeBlockNode().updateFromJSON(serialized);
	}

	getLanguage(): string {
		return $getState(this, languageState);
	}

	setLanguage(value: string): this {
		return $setState(this.getWritable(), languageState, value);
	}

	getMeta(): string {
		return $getState(this, metaState);
	}

	setMeta(value: string): this {
		return $setState(this.getWritable(), metaState, value);
	}

	override exportJSON(): SerializedCode {
		return { ...super.exportJSON(), planLanguage: this.getLanguage(), planMeta: this.getMeta() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedCode>): this {
		return super.updateFromJSON(serialized)
			.setLanguage(serialized.planLanguage ?? "")
			.setMeta(serialized.planMeta ?? "");
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let dom = document.createElement("div");
		dom.className = config.theme.planCode ?? "planCode";
		if (this.getLanguage()) dom.dataset.planLanguage = this.getLanguage();

		// Rendered output (a diagram, say) lives beside the source rather than
		// replacing it, so the text Yjs synchronises stays editable.
		let preview = document.createElement("div");
		preview.dataset.planPreview = "";
		setDOMUnmanaged(preview);
		dom.append(preview);

		// Somewhere for the UI to hang controls that act on the block rather
		// than edit it, kept out of the reconciled slot so Lexical does not
		// treat them as stray children.
		let chrome = document.createElement("div");
		chrome.dataset.planChrome = "block";
		setDOMUnmanaged(chrome);
		dom.append(chrome);

		let source = document.createElement("pre");
		source.dataset.planSource = "";
		source.spellcheck = false;
		dom.append(source);

		return dom;
	}

	override getDOMSlot(element: HTMLElement): ElementDOMSlot {
		let source = element.querySelector<HTMLElement>("[data-plan-source]");
		return super.getDOMSlot(element).withElement(source ?? element);
	}

	override updateDOM(prev: CodeBlockNode, dom: HTMLElement): boolean {
		if (prev.getLanguage() !== this.getLanguage()) {
			dom.dataset.planLanguage = this.getLanguage();
		}
		return false;
	}

	/** Newlines are content here, not paragraph breaks. */
	override collapseAtStart(): boolean {
		return false;
	}
}

export function $createCodeBlockNode(language = "", value = "", meta = ""): CodeBlockNode {
	// Markdown can only write meta after a language, so keeping it without one
	// would produce a node that cannot be serialised back to its own source.
	let node = $applyNodeReplacement(
		new CodeBlockNode().setLanguage(language).setMeta(language ? meta : ""),
	);
	if (value) node.append($createTextNode(value));
	return node;
}

export function $isCodeBlockNode(node: LexicalNode | null | undefined): node is CodeBlockNode {
	return node instanceof CodeBlockNode;
}

// -- math ------------------------------------------------------------------

type SerializedMath = Spread<{ planInline: boolean; planMeta: string }, SerializedElementNode>;

/** A LaTeX formula. Its source is a text child so it stays collaborative. */
export class MathNode extends ElementNode {
	static override getType(): string {
		return "plan-math";
	}

	static override clone(node: MathNode): MathNode {
		return new MathNode(node.__key);
	}

	static override importJSON(serialized: SerializedMath): MathNode {
		return $createMathNode().updateFromJSON(serialized);
	}

	isInlineMath(): boolean {
		return $getState(this, inlineState);
	}

	setInlineMath(value: boolean): this {
		return $setState(this.getWritable(), inlineState, value);
	}

	/** Block math only: `$…$` has nowhere to put an info string. */
	getMeta(): string {
		return $getState(this, metaState);
	}

	setMeta(value: string): this {
		return $setState(this.getWritable(), metaState, value);
	}

	override isInline(): boolean {
		return this.isInlineMath();
	}

	override exportJSON(): SerializedMath {
		return { ...super.exportJSON(), planInline: this.isInlineMath(), planMeta: this.getMeta() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedMath>): this {
		return super.updateFromJSON(serialized)
			.setInlineMath(serialized.planInline ?? false)
			.setMeta(serialized.planMeta ?? "");
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let dom = document.createElement(this.isInlineMath() ? "span" : "div");
		dom.className = config.theme.planMath ?? "planMath";
		dom.dataset.planInline = String(this.isInlineMath());

		let preview = document.createElement(this.isInlineMath() ? "span" : "div");
		preview.dataset.planPreview = "";
		setDOMUnmanaged(preview);
		dom.append(preview);

		// Only a block formula has room for chrome; inline math sits in a
		// sentence, where a control would break the line it belongs to.
		if (!this.isInlineMath()) {
			let chrome = document.createElement("div");
			chrome.dataset.planChrome = "block";
			setDOMUnmanaged(chrome);
			dom.append(chrome);
		}

		let source = document.createElement(this.isInlineMath() ? "span" : "div");
		source.dataset.planSource = "";
		dom.append(source);

		return dom;
	}

	override getDOMSlot(element: HTMLElement): ElementDOMSlot {
		let source = element.querySelector<HTMLElement>("[data-plan-source]");
		return super.getDOMSlot(element).withElement(source ?? element);
	}

	override updateDOM(prev: MathNode): boolean {
		// Switching between inline and block changes the element.
		return prev.isInlineMath() !== this.isInlineMath();
	}
}

export function $createMathNode(inline = false, value = "", meta = ""): MathNode {
	let node = $applyNodeReplacement(
		new MathNode().setInlineMath(inline).setMeta(inline ? "" : meta),
	);
	if (value) node.append($createTextNode(value));
	return node;
}

export function $isMathNode(node: LexicalNode | null | undefined): node is MathNode {
	return node instanceof MathNode;
}

// -- image -----------------------------------------------------------------

type SerializedImage = Spread<{ planSrc: string; planAlt: string }, SerializedLexicalNode>;

/** A remote image, referenced by absolute URL. */
export class ImageNode extends DecoratorNode<unknown> {
	static override getType(): string {
		return "plan-image";
	}

	static override clone(node: ImageNode): ImageNode {
		return new ImageNode(node.__key);
	}

	static override importJSON(serialized: SerializedImage): ImageNode {
		return $createImageNode().updateFromJSON(serialized);
	}

	getSrc(): string {
		return $getState(this, srcState);
	}

	setSrc(value: string): this {
		return $setState(this.getWritable(), srcState, value);
	}

	getAlt(): string {
		return $getState(this, altState);
	}

	setAlt(value: string): this {
		return $setState(this.getWritable(), altState, value);
	}

	override exportJSON(): SerializedImage {
		return { ...super.exportJSON(), planSrc: this.getSrc(), planAlt: this.getAlt() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedImage>): this {
		return super.updateFromJSON(serialized)
			.setSrc(serialized.planSrc ?? "")
			.setAlt(serialized.planAlt ?? "");
	}

	override createDOM(): HTMLElement {
		let dom = document.createElement("span");
		dom.dataset.planSrc = this.getSrc();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}

	/** `@chopin/editor` renders the image; headless conversion never calls this. */
	override decorate(): unknown {
		return render(this);
	}
}

export function $createImageNode(src = "", alt = ""): ImageNode {
	return $applyNodeReplacement(new ImageNode().setSrc(src).setAlt(alt));
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
	return node instanceof ImageNode;
}

// -- footnotes -------------------------------------------------------------

type SerializedFootnoteReference = Spread<{ planIdentifier: string }, SerializedLexicalNode>;

/** The marker in prose. Display numbering is derived from document order. */
export class FootnoteReferenceNode extends DecoratorNode<unknown> {
	static override getType(): string {
		return "plan-footnote-reference";
	}

	static override clone(node: FootnoteReferenceNode): FootnoteReferenceNode {
		return new FootnoteReferenceNode(node.__key);
	}

	static override importJSON(serialized: SerializedFootnoteReference): FootnoteReferenceNode {
		return $createFootnoteReferenceNode().updateFromJSON(serialized);
	}

	getIdentifier(): string {
		return $getState(this, identifierState);
	}

	setIdentifier(value: string): this {
		return $setState(this.getWritable(), identifierState, value);
	}

	override isInline(): boolean {
		return true;
	}

	override exportJSON(): SerializedFootnoteReference {
		return { ...super.exportJSON(), planIdentifier: this.getIdentifier() };
	}

	override updateFromJSON(
		serialized: LexicalUpdateJSON<SerializedFootnoteReference>,
	): this {
		return super.updateFromJSON(serialized).setIdentifier(serialized.planIdentifier ?? "");
	}

	override createDOM(): HTMLElement {
		let dom = document.createElement("sup");
		dom.dataset.planFootnote = this.getIdentifier();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}

	override decorate(): unknown {
		return render(this);
	}
}

export function $createFootnoteReferenceNode(identifier = ""): FootnoteReferenceNode {
	return $applyNodeReplacement(new FootnoteReferenceNode().setIdentifier(identifier));
}

export function $isFootnoteReferenceNode(
	node: LexicalNode | null | undefined,
): node is FootnoteReferenceNode {
	return node instanceof FootnoteReferenceNode;
}

type SerializedFootnoteDefinition = Spread<{ planIdentifier: string }, SerializedElementNode>;

/** The footnote body. Block content, so it collaborates like any other prose. */
export class FootnoteDefinitionNode extends ElementNode {
	static override getType(): string {
		return "plan-footnote-definition";
	}

	static override clone(node: FootnoteDefinitionNode): FootnoteDefinitionNode {
		return new FootnoteDefinitionNode(node.__key);
	}

	static override importJSON(serialized: SerializedFootnoteDefinition): FootnoteDefinitionNode {
		return $createFootnoteDefinitionNode().updateFromJSON(serialized);
	}

	getIdentifier(): string {
		return $getState(this, identifierState);
	}

	setIdentifier(value: string): this {
		return $setState(this.getWritable(), identifierState, value);
	}

	override exportJSON(): SerializedFootnoteDefinition {
		return { ...super.exportJSON(), planIdentifier: this.getIdentifier() };
	}

	override updateFromJSON(
		serialized: LexicalUpdateJSON<SerializedFootnoteDefinition>,
	): this {
		return super.updateFromJSON(serialized).setIdentifier(serialized.planIdentifier ?? "");
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let dom = document.createElement("section");
		dom.className = config.theme.planFootnote ?? "planFootnote";
		dom.dataset.planFootnote = this.getIdentifier();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}
}

export function $createFootnoteDefinitionNode(identifier = ""): FootnoteDefinitionNode {
	return $applyNodeReplacement(new FootnoteDefinitionNode().setIdentifier(identifier));
}

export function $isFootnoteDefinitionNode(
	node: LexicalNode | null | undefined,
): node is FootnoteDefinitionNode {
	return node instanceof FootnoteDefinitionNode;
}

export const CONTENT_NODES = [
	CodeBlockNode,
	MathNode,
	ImageNode,
	FootnoteReferenceNode,
	FootnoteDefinitionNode,
];
