/** Shared DOM behavior and class lists for the slash menu and selection toolbar. */

import { currentViewport, listenToViewportChanges } from "@chopin/viewport";

import { intersectViewport } from "./placement";

import type { LexicalEditor } from "lexical";
import type { DOMRectLike, ViewportBox } from "./placement";

/** The live browser geometry for Lexical's native selection, without changing it. */
export function nativeSelectionRect(): DOMRectLike | undefined {
	let selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;
	return selection.getRangeAt(0).getBoundingClientRect();
}

/** The visible editor pixels shared by every fixed surface placed over it. */
export function editorSurfaceViewport(editor: LexicalEditor): ViewportBox {
	let viewport = currentViewport();
	let host = editor.getRootElement()?.closest<HTMLElement>(".plan-document")
		?.getBoundingClientRect();
	return host ? intersectViewport(viewport, host) : viewport;
}

/** Keep fixed editor chrome attached through document and visual-viewport movement. */
export function listenToEditorGeometry(editor: LexicalEditor, listener: () => void): () => void {
	let scroller = editor.getRootElement()?.closest<HTMLElement>(".plan-document")
		?.firstElementChild;
	return listenToViewportChanges(listener, {
		observeDocumentScroll: true,
		scrollTargets: scroller ? [scroller] : [],
	});
}

export const SHELL = "fixed z-50 rounded-lg bg-page p-1 ring-hairline shadow-raised";
export const ROW =
	"plan-menu-row flex h-8 w-full items-center rounded-sm px-2 text-left text-sm transition";
export const CELL = "plan-menu-cell size-7 shrink-0 rounded-sm text-sm font-semibold transition";
export const CELL_ON = "bg-selected text-text-primary";
export const CELL_OFF = "text-text-tertiary hover:bg-hover hover:text-text-primary";
export const DIVIDER = "my-1 hairline-b";
export const SEAM = "mx-0.5 h-4 hairline-l";
