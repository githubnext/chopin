import {
	$createRangeSelectionFromDom,
	$getSelection,
	$isRangeSelection,
	$setSelection,
} from "lexical";

import type { LexicalEditor, RangeSelection } from "lexical";

function $samePoints(a: RangeSelection, b: RangeSelection): boolean {
	return a.anchor.key === b.anchor.key
		&& a.anchor.offset === b.anchor.offset
		&& a.anchor.type === b.anchor.type
		&& a.focus.key === b.focus.key
		&& a.focus.offset === b.focus.offset
		&& a.focus.type === b.focus.type;
}

/**
 * The range selection at the caret now, from the page's own selection when a press moved it and
 * `selectionchange` has not yet told Lexical. Keeps Lexical's current range selection when its
 * endpoints already match, so pending inline formats on a collapsed caret stay intact.
 */
export function $liveRangeSelection(editor?: LexicalEditor): RangeSelection | undefined {
	let current = $getSelection();
	let dom = typeof window !== "undefined"
		? editor?.getRootElement()?.ownerDocument.getSelection()
		: undefined;
	let fromDom: RangeSelection | null = null;
	if (dom?.rangeCount && editor) {
		try {
			fromDom = $createRangeSelectionFromDom(dom, editor);
		} catch {
			fromDom = null;
		}
	}
	if (fromDom) {
		return $isRangeSelection(current) && $samePoints(current, fromDom) ? current : fromDom;
	}
	return $isRangeSelection(current) ? current : undefined;
}

/**
 * Commits the live caret into the active update when a press moved the page's selection ahead of
 * `selectionchange`, so commands that mutate or dispatch on `$getSelection()` act on the pressed
 * block and keep the caret there.
 */
export function $syncLiveRangeSelection(editor: LexicalEditor): RangeSelection | undefined {
	let live = $liveRangeSelection(editor);
	if (live && live !== $getSelection()) $setSelection(live);
	return live;
}
