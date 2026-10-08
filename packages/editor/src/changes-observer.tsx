/**
 * Keeps the agent's marks on the right blocks as the document moves.
 *
 * Mounted inside the editor, because placing a mark needs to read the document
 * and Lexical only lends that out to a composer child. Kept apart from the
 * store itself so nothing that touches React is in the way of testing the
 * bookkeeping.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection, COLLABORATION_TAG } from "lexical";

import type { ChangeStore } from "./changes";

/** How long after mounting updates are still the document loading. */
const SETTLE = 1_000;

/** Past this many blocks at once it is a rewrite, and opening each one is noise. */
const MOST = 8;

export function ChangeObserver({ store }: { store: ChangeStore }) {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		store.attach(editor);
		store.refresh();

		// Every keystroke lands here, and almost none of them move a mark. The
		// store returns immediately when it is holding none, which is what
		// keeps that from costing anything while nobody is watching an edit.
		let off = editor.registerUpdateListener(store.refresh);

		// The first updates are the document arriving, not anybody adding to it.
		let since = performance.now();
		let offArrivals = editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
			// Only the agent's writing. A person's Enter is part of their typing,
			// and drawing it out would make everyone else's text drift with it.
			if (!tags.has(COLLABORATION_TAG) || !store.agentWriting) return;
			if (performance.now() - since < SETTLE) return;
			let before = prevEditorState.read(() => $getRoot().getChildrenKeys());
			let [after, caret] = editorState.read(() => {
				let selection = $getSelection();
				let block = $isRangeSelection(selection)
					? selection.focus.getNode().getTopLevelElement()?.getKey()
					: undefined;
				return [$getRoot().getChildrenKeys(), block] as const;
			});
			if (before.length === 0) return;

			// Where blocks went, by the block that survived just above them.
			// Something new in the same place is a rewrite, not new space, and
			// opening it from nothing would shut the gap and then reopen it.
			let kept = new Set(after);
			let vacated = new Set<string | undefined>();
			let above: string | undefined;
			for (let key of before) {
				if (kept.has(key)) above = key;
				else vacated.add(above);
			}

			// Nothing above the reader's own line opens: it would carry that line
			// down under them for as long as it ran. Without focus, being on
			// screen is the test, which the store applies.
			let focused = editor.getRootElement()?.contains(document.activeElement) === true;
			let below = !focused || caret === undefined;

			let old = new Set(before);
			let added: string[] = [];
			above = undefined;
			for (let key of after) {
				if (key === caret) below = true;
				if (old.has(key)) above = key;
				else if (below && !vacated.has(above)) added.push(key);
			}
			if (added.length === 0 || added.length > MOST) return;
			store.arrived(added.flatMap(key => editor.getElementByKey(key) ?? []));
		});

		return () => {
			off();
			offArrivals();
			store.attach(undefined);
		};
	}, [editor, store]);

	return null;
}
