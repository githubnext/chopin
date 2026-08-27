/**
 * Structural plan components.
 *
 * Each is an `ElementNode` whose children are ordinary Lexical blocks, so their
 * content collaborates exactly like top-level prose.
 *
 * The DOM produced here is deliberately plain and semantic. Presentation and
 * interaction (tab strips, callout chrome) belong to `@chopin/editor`, which
 * enhances these elements without owning the document model.
 */

import {
	$applyNodeReplacement,
	$getState,
	$setState,
	createState,
	ElementNode,
	setDOMUnmanaged,
} from "lexical";

import { CALLOUT_TYPES } from "../dialect";
import { idState } from "./identity";

import type {
	EditorConfig,
	ElementDOMSlot,
	LexicalNode,
	LexicalUpdateJSON,
	NodeKey,
	SerializedElementNode,
	Spread,
} from "lexical";

type CalloutType = (typeof CALLOUT_TYPES)[number];

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** NodeState getters resolve through the active state even on a previous clone. */
function syncDOMAttribute(dom: HTMLElement, name: string, value: string | undefined): void {
	if (value === undefined) dom.removeAttribute(name);
	else dom.setAttribute(name, value);
}

/** Tab label. */
export const labelState = createState("plan-label", { parse: text });

/** Callout severity. */
export const typeState = createState("plan-type", {
	parse: (value: unknown): CalloutType =>
		CALLOUT_TYPES.includes(value as CalloutType) ? (value as CalloutType) : "note",
});

/** Optional callout heading. */
export const titleState = createState("plan-title", { parse: text });

type SerializedContainer = Spread<{ planId: string }, SerializedElementNode>;

/**
 * Base for every identified block container.
 *
 * `id` is mirrored into `exportJSON` so copy/paste and editor-state snapshots
 * keep it, while node state remains the source of truth for collaboration.
 */
abstract class ContainerNode extends ElementNode {
	static override importJSON(serialized: SerializedContainer): ContainerNode {
		throw new Error(`${serialized.type} must implement importJSON`);
	}

	getId(): string {
		return $getState(this, idState);
	}

	setId(value: string): this {
		return $setState(this.getWritable(), idState, value);
	}

	override exportJSON(): SerializedContainer {
		return { ...super.exportJSON(), planId: this.getId() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedContainer>): this {
		return super.updateFromJSON(serialized).setId(serialized.planId ?? "");
	}

	protected element(config: EditorConfig, tag: string, className: string): HTMLElement {
		let dom = document.createElement(tag);
		dom.className = config.theme[className] ?? className;
		if (this.getId()) dom.dataset.planId = this.getId();
		return dom;
	}

	override updateDOM(_prev: ContainerNode, _dom: HTMLElement): boolean {
		return false;
	}

	override isShadowRoot(): boolean {
		return false;
	}
}

// -- Tabs ------------------------------------------------------------------

export class TabsNode extends ContainerNode {
	static override getType(): string {
		return "plan-tabs";
	}

	static override clone(node: TabsNode): TabsNode {
		return new TabsNode(node.__key);
	}

	static override importJSON(serialized: SerializedContainer): TabsNode {
		return $createTabsNode().updateFromJSON(serialized);
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let dom = this.element(config, "div", "planTabs");
		dom.setAttribute("role", "presentation");

		// The tab strip is chrome, not content. Giving it its own container and
		// marking it unmanaged lets the UI render into it without Lexical's
		// reconciler treating it as a stray child and removing it.
		let chrome = document.createElement("div");
		chrome.dataset.planChrome = "tabs";
		setDOMUnmanaged(chrome);
		dom.append(chrome);

		let panels = document.createElement("div");
		panels.dataset.planPanels = "";
		dom.append(panels);

		return dom;
	}

	/** Children belong in the panels container, never beside the chrome. */
	override getDOMSlot(element: HTMLElement): ElementDOMSlot {
		let panels = element.querySelector<HTMLElement>("[data-plan-panels]");
		return super.getDOMSlot(element).withElement(panels ?? element);
	}
}

export function $createTabsNode(id = ""): TabsNode {
	return $applyNodeReplacement(new TabsNode().setId(id));
}

export function $isTabsNode(node: LexicalNode | null | undefined): node is TabsNode {
	return node instanceof TabsNode;
}

type SerializedTab = Spread<{ planLabel: string }, SerializedContainer>;

export class TabNode extends ContainerNode {
	static override getType(): string {
		return "plan-tab";
	}

	static override clone(node: TabNode): TabNode {
		return new TabNode(node.__key);
	}

	static override importJSON(serialized: SerializedTab): TabNode {
		return $createTabNode().updateFromJSON(serialized);
	}

	getLabel(): string {
		return $getState(this, labelState);
	}

	setLabel(value: string): this {
		return $setState(this.getWritable(), labelState, value);
	}

	override exportJSON(): SerializedTab {
		return { ...super.exportJSON(), planLabel: this.getLabel() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedTab>): this {
		return super.updateFromJSON(serialized).setLabel(serialized.planLabel ?? "");
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let dom = this.element(config, "section", "planTab");
		dom.setAttribute("role", "tabpanel");
		dom.setAttribute("aria-label", this.getLabel());
		return dom;
	}

	override updateDOM(_prev: TabNode, dom: HTMLElement): boolean {
		syncDOMAttribute(dom, "aria-label", this.getLabel());
		return false;
	}
}

export function $createTabNode(id = "", label = ""): TabNode {
	return $applyNodeReplacement(new TabNode().setId(id).setLabel(label));
}

export function $isTabNode(node: LexicalNode | null | undefined): node is TabNode {
	return node instanceof TabNode;
}

// -- Callout ---------------------------------------------------------------

type SerializedCallout = Spread<
	{ planType: CalloutType; planTitle: string },
	SerializedContainer
>;

export class CalloutNode extends ContainerNode {
	static override getType(): string {
		return "plan-callout";
	}

	static override clone(node: CalloutNode): CalloutNode {
		return new CalloutNode(node.__key);
	}

	static override importJSON(serialized: SerializedCallout): CalloutNode {
		return $createCalloutNode().updateFromJSON(serialized);
	}

	getCalloutType(): CalloutType {
		return $getState(this, typeState);
	}

	setCalloutType(value: CalloutType): this {
		return $setState(this.getWritable(), typeState, value);
	}

	getTitle(): string {
		return $getState(this, titleState);
	}

	setTitle(value: string): this {
		return $setState(this.getWritable(), titleState, value);
	}

	override exportJSON(): SerializedCallout {
		return { ...super.exportJSON(), planType: this.getCalloutType(), planTitle: this.getTitle() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedCallout>): this {
		return super.updateFromJSON(serialized)
			.setCalloutType(serialized.planType ?? "note")
			.setTitle(serialized.planTitle ?? "");
	}

	override createDOM(config: EditorConfig): HTMLElement {
		let dom = this.element(config, "aside", "planCallout");
		dom.dataset.planType = this.getCalloutType();
		if (this.getTitle()) dom.setAttribute("aria-label", this.getTitle());

		// The heading is chrome derived from attributes, not editable content,
		// so it lives outside the slot Lexical reconciles.
		let chrome = document.createElement("div");
		chrome.dataset.planChrome = "callout";
		setDOMUnmanaged(chrome);
		dom.append(chrome);

		let body = document.createElement("div");
		body.dataset.planBody = "";
		dom.append(body);

		return dom;
	}

	override getDOMSlot(element: HTMLElement): ElementDOMSlot {
		let body = element.querySelector<HTMLElement>("[data-plan-body]");
		return super.getDOMSlot(element).withElement(body ?? element);
	}

	override updateDOM(_prev: CalloutNode, dom: HTMLElement): boolean {
		syncDOMAttribute(dom, "data-plan-type", this.getCalloutType());
		syncDOMAttribute(dom, "aria-label", this.getTitle() || undefined);
		return false;
	}
}

export function $createCalloutNode(
	id = "",
	type: CalloutType = "note",
	title = "",
): CalloutNode {
	return $applyNodeReplacement(new CalloutNode().setId(id).setCalloutType(type).setTitle(title));
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
	return node instanceof CalloutNode;
}

export const CONTAINER_NODES = [TabsNode, TabNode, CalloutNode];

export type { CalloutType, NodeKey, SerializedCallout, SerializedContainer, SerializedTab };
