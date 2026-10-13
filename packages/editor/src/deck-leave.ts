/**
 * Where the reader goes when a deck dissolves and leaves nothing to focus.
 *
 * Answering a deck's last open card dissolves it, and its decided cards draw
 * nothing in the document. Focus would fall to the page, so the caret goes to
 * the start of the block after the run instead, or to the document's first
 * paragraph when nothing follows, and the save is said aloud.
 */

import { $getRoot, $isElementNode, $isParagraphNode } from "lexical";

import { $isQuestionnaireNode } from "@chopin/dialect";

import type { LexicalEditor } from "lexical";

/** Put the caret after a run of decisions; false when the document has nowhere to put it. */
export function $caretAfterRun(run: readonly string[]): boolean {
	let ids = new Set(run);
	let children = $getRoot().getChildren();
	let last = children.findLastIndex(node => $isQuestionnaireNode(node) && ids.has(node.getId()));
	let next = children.slice(last + 1).find(node => !$isQuestionnaireNode(node))
		?? children.find(node => $isParagraphNode(node));
	if (!next || !$isElementNode(next)) return false;
	next.selectStart();
	return true;
}

export function leaveDeck(editor: LexicalEditor, run: readonly string[]): void {
	let placed = false;
	editor.update(() => {
		placed = $caretAfterRun(run);
	}, { discrete: true });
	if (placed) editor.getRootElement()?.focus({ preventScroll: true });
	announcePolitely("Decision saved");
}

/** A page-wide polite status, for words that outlive the control that caused them. */
export function announcePolitely(text: string): void {
	let region = document.querySelector<HTMLElement>("[data-plan-announcer]");
	if (!region) {
		region = document.createElement("p");
		region.setAttribute("data-plan-announcer", "");
		region.setAttribute("role", "status");
		region.setAttribute("aria-live", "polite");
		region.setAttribute("aria-atomic", "true");
		region.className = "sr-only";
		document.body.append(region);
	}
	// Cleared first, so saying the same words twice is still heard.
	region.textContent = "";
	let target = region;
	requestAnimationFrame(() => target.textContent = text);
}
