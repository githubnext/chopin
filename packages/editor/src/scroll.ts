/**
 * Going to a block, from a node key.
 *
 * The sidecar knows where a card points as Lexical keys, and a key can name a
 * phrase inside a paragraph as easily as the paragraph itself: a comment
 * resolves to text nodes, a decision's result resolves to blocks. Both have to
 * arrive at the same thing on screen, so everything is walked up to the block
 * it sits in first.
 *
 * The scroll container is not asked for. `scrollIntoView` walks the ancestor
 * chain by itself, and the only ancestor of the prose that scrolls is the
 * document column — the panes beside it are `overflow-hidden` and the workspace
 * does not scroll at all. Threading a viewport through two more stores would
 * buy a reference nothing would read.
 *
 * Untested, deliberately. There is no DOM in the test runtime, so this is the
 * whole of the part that needs a browser, kept apart from the part that decides
 * where to go — which is in the stores and is tested there.
 */

import type { LexicalEditor } from "lexical";

/** The explicitly marked scroll owner for editor chrome anchored to the plan. */
export function planScroller(element: Element | null | undefined): HTMLElement | undefined {
	return element?.closest<HTMLElement>(".plan-document")
		?.querySelector<HTMLElement>(":scope > [data-plan-scroll]") ?? undefined;
}

/**
 * The block element a node key sits in.
 *
 * Guarded: a headless editor has no elements and says so by throwing rather
 * than by returning nothing.
 */
export function blockElement(editor: LexicalEditor, key: string): HTMLElement | undefined {
	try {
		let element = editor.getElementByKey(key);
		if (!element) return undefined;

		// The root element is `.plan-content`, so its direct children are the
		// blocks both ends of the wire count.
		let block = element.closest<HTMLElement>(".plan-content > *");
		return block ?? element;
	} catch {
		return undefined;
	}
}

/** Bring the block a key sits in into view, if there is a view to bring it into. */
export function scrollToKey(editor: LexicalEditor, key: string): void {
	let element = blockElement(editor, key);
	if (!element?.scrollIntoView) return;

	element.scrollIntoView({
		block: "center",
		// A scroll behaviour set in script is out of the stylesheet's reach, so
		// the reduced-motion preference has to be read here.
		behavior: typeof matchMedia === "function"
				&& matchMedia("(prefers-reduced-motion: reduce)").matches
			? "auto"
			: "smooth",
	});
}
