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

import type { ChangeStore } from "./changes";

export function ChangeObserver({ store }: { store: ChangeStore }) {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		store.attach(editor);
		store.refresh();

		// Every keystroke lands here, and almost none of them move a mark. The
		// store returns immediately when it is holding none, which is what
		// keeps that from costing anything while nobody is watching an edit.
		let off = editor.registerUpdateListener(store.refresh);

		return () => {
			off();
			store.attach(undefined);
		};
	}, [editor, store]);

	return null;
}
