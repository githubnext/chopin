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

import { counts, relate } from "./anchors";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Plan } from "@chopin/protocol";
import type { Related, Relation } from "./anchors";
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

/** What is currently lit up, and why. */
export type Highlight = { widget: string; question: string; relation: Relation };

export class QuestionnaireStore {
	#entries: QuestionnaireEntry[] = [];
	#listeners = new Set<() => void>();

	/** Needed to turn an anchor into a node key, and a key into an element. */
	#binding: Binding | undefined;
	#editor: LexicalEditor | undefined;
	#related: Related[] = [];
	#lit: string[] = [];

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

	// -- relationships -------------------------------------------------------

	/** The editor, so a node key can be turned into something on screen. */
	attach(editor: LexicalEditor | undefined): void {
		this.#editor = editor;
	}

	/** The Yjs binding, so a relative position can be turned into a node key. */
	bind(binding: Binding | undefined): void {
		this.#binding = binding;
	}

	/**
	 * Take a new snapshot from the server.
	 *
	 * Resolved immediately rather than on demand: the positions are only
	 * meaningful against the document as it is now, and resolving later would
	 * be resolving against a document that has moved on.
	 */
	anchors(widgets: Plan.WidgetAnchors[]): void {
		if (!this.#binding) return;
		try {
			this.#related = relate(this.#binding, widgets);
		} catch (err) {
			// Where a decision points is decoration. This is called while the
			// document is being opened, so letting it throw would cost the room
			// the plan itself rather than a few outlines.
			console.error("[plan] could not resolve what decisions relate to:", err);
			return;
		}
		for (let listener of this.#listeners) listener();
	}

	/** How much prose each of a questionnaire's questions resolves to. */
	counts(widget: string): { [question: string]: { subject: number; result: number } } {
		return counts(this.#related, widget);
	}

	/**
	 * Mark the prose a relationship names.
	 *
	 * Written to the DOM rather than to the document. A highlight is one
	 * reader's pointer, not a fact about the plan, and putting it in the
	 * document would send it to everybody else and make it undoable.
	 */
	highlight(widget: string, question: string, relation: Relation): void {
		this.clear();
		let found = this.#related.find(item =>
			item.widget === widget && item.question === question && item.relation === relation
		);
		if (!found || found.pending) return;

		for (let key of found.keys) {
			let element = this.#editor?.getElementByKey(key);
			if (!element) continue;
			element.setAttribute("data-plan-related", "");
			this.#lit.push(key);
		}
	}

	clear(): void {
		for (let key of this.#lit) {
			this.#editor?.getElementByKey(key)?.removeAttribute("data-plan-related");
		}
		this.#lit = [];
	}
}

/** Mounted inside the editor, so it can read the document as it changes. */
export function QuestionnaireObserver({ store }: { store: QuestionnaireStore }) {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		store.attach(editor);
		let read = () => editor.getEditorState().read(() => store.set(collectQuestionnaires()));
		read();
		let off = editor.registerUpdateListener(read);
		return () => {
			off();
			store.attach(undefined);
		};
	}, [editor, store]);

	return null;
}

export function useQuestionnaires(store: QuestionnaireStore): QuestionnaireEntry[] {
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	return useSyncExternalStore(subscribe, store.snapshot, store.snapshot);
}
