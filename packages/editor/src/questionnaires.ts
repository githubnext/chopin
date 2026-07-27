/**
 * Which questionnaires the plan currently holds.
 *
 * The document is the source of truth for what exists — a questionnaire is a
 * node in it — but the card that answers one is rendered outside the editor,
 * in the decisions pane. This is the bridge: it watches the document and
 * publishes a plain list, so the pane never has to reach into Lexical.
 *
 * An external store rather than React state because the update arrives from a
 * Lexical listener, which knows nothing about rendering and should not have to.
 */

import { useCallback, useSyncExternalStore } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $nodesOfType } from "lexical";
import { useEffect } from "react";

import { QuestionnaireNode } from "@chopin/dialect";

import type { Questionnaire } from "@chopin/dialect";

export type QuestionnaireEntry = {
	id: string;
	value: Questionnaire;
};

/** Read the document's questionnaires, in the order they appear in the prose. */
export function collectQuestionnaires(): QuestionnaireEntry[] {
	return $nodesOfType(QuestionnaireNode).map(node => ({
		id: node.getId(),
		value: node.getQuestionnaire(),
	}));
}

export class QuestionnaireStore {
	#entries: QuestionnaireEntry[] = [];
	#listeners = new Set<() => void>();

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): QuestionnaireEntry[] => this.#entries;

	/**
	 * Publish a new list, if it is actually new.
	 *
	 * Every keystroke in the plan produces an update, and almost none of them
	 * change a questionnaire. Comparing before publishing is what keeps the
	 * decisions pane from re-rendering on every character typed in the prose.
	 */
	set(entries: QuestionnaireEntry[]): void {
		if (JSON.stringify(entries) === JSON.stringify(this.#entries)) return;
		this.#entries = entries;
		for (let listener of this.#listeners) listener();
	}
}

/** Mounted inside the editor, so it can read the document as it changes. */
export function QuestionnaireObserver({ store }: { store: QuestionnaireStore }) {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		let read = () => editor.getEditorState().read(() => store.set(collectQuestionnaires()));
		read();
		return editor.registerUpdateListener(read);
	}, [editor, store]);

	return null;
}

export function useQuestionnaires(store: QuestionnaireStore): QuestionnaireEntry[] {
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	return useSyncExternalStore(subscribe, store.snapshot, store.snapshot);
}
