/**
 * Which questionnaires the plan currently holds.
 *
 * The document is the source of truth for what exists — a questionnaire is a
 * node in it. This bridge publishes a plain list for document views without
 * making them reach into Lexical.
 *
 * An external store rather than React state because the update arrives from a
 * Lexical listener, which knows nothing about rendering and should not have to.
 */

import { useCallback, useSyncExternalStore } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isParagraphNode, $nodesOfType } from "lexical";
import { useEffect } from "react";

import { $isDecisionNode, $isQuestionnaireNode, QuestionnaireNode } from "@chopin/dialect";

import { counts, relate } from "./anchors";
import { holds, paint, pin, unpin } from "./marks";
import { $blockPoints } from "./passage";
import { scrollToKey } from "./scroll";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Plan } from "@chopin/protocol";
import type { Related } from "./anchors";
import type { Points } from "./passage";
import type { Questionnaire } from "@chopin/dialect";

export type QuestionnaireEntry = {
	id: string;
	value: Questionnaire;
};

export type PlanQuestionnaireState = {
	entries: QuestionnaireEntry[];
	hasPlanContent: boolean;
};

/** Read the document's questionnaires, in the order they appear in the prose. */
export function collectQuestionnaires(): QuestionnaireEntry[] {
	return $nodesOfType(QuestionnaireNode).map(node => ({
		id: node.getId(),
		value: node.getQuestionnaire(),
	}));
}

/** Read the document's questionnaires and whether it contains ordinary prose. */
export function collectPlanState(): PlanQuestionnaireState {
	let entries = collectQuestionnaires();
	let hasPlanContent = $getRoot().getChildren().some(node => {
		if ($isQuestionnaireNode(node) || $isDecisionNode(node)) return false;
		if ($isParagraphNode(node) && node.getChildrenSize() === 0) return false;
		return true;
	});
	return { entries, hasPlanContent };
}

export class QuestionnaireStore {
	#state: PlanQuestionnaireState = { entries: [], hasPlanContent: false };
	#listeners = new Set<() => void>();

	/** Needed to turn an anchor into a node key, and a key into an element. */
	#binding: Binding | undefined;
	#editor: LexicalEditor | undefined;
	#related: Related[] = [];
	/**
	 * Which decision the reader last asked to be taken to, and how far along
	 * it. Never cleared: whether it is still live is the pin's answer.
	 */
	#walk: { widget: string; question: string; index: number } | undefined;

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): QuestionnaireEntry[] => this.#state.entries;
	contentSnapshot = (): boolean => this.#state.hasPlanContent;

	/**
	 * Publish a new list, if it is actually new.
	 *
	 * Every keystroke in the plan produces an update, and almost none of them
	 * change a questionnaire. Comparing before publishing is what keeps the
	 * decisions pane from re-rendering on every character typed in the prose.
	 */
	set(state: PlanQuestionnaireState): void {
		if (JSON.stringify(state) === JSON.stringify(this.#state)) return;
		this.#state = state;
		for (let listener of this.#listeners) listener();
	}

	// -- relationships -------------------------------------------------------

	/** The editor, so a node key can be turned into something on screen. */
	attach(editor: LexicalEditor | undefined): void {
		// Everything, not just the preview: a pin outlives the pointer but it
		// cannot outlive the document it names.
		if (!editor && this.#editor) this.release();
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

	/** How much prose each of a questionnaire's decisions resolves to. */
	counts(widget: string): { [question: string]: number } {
		return counts(this.#related, widget);
	}

	/**
	 * Mark the prose a decision lives in.
	 *
	 * Painted rather than written into the document. A highlight is one
	 * reader's pointer, not a fact about the plan, and putting it in the
	 * document would send it to everybody else and make it undoable.
	 *
	 * Through the same registry comments use, under the same tone, so pointing
	 * at a question and pointing at a comment look like the same act. They used
	 * to be an outlined block and a washed range respectively, which made one
	 * fact — this is the prose that card refers to — read as two.
	 */
	highlight(widget: string, question: string): void {
		let editor = this.#editor;
		if (!editor) return;

		let places = this.#places(widget, question);
		if (!places) return this.clear();

		paint(editor, "questions", places);
	}

	/**
	 * Take the reader to the prose a decision lives in.
	 *
	 * The click behind `Show in plan`, which a question has offered for as long
	 * as there has been anywhere to send one and which used to do nothing at
	 * all. A decision can have produced several blocks — the button says how
	 * many — so clicking again walks to the next and round.
	 */
	reveal(widget: string, question: string): void {
		let editor = this.#editor;
		if (!editor) return;

		let places = this.#places(widget, question);
		if (!places || places.length === 0) return;

		let walk = this.#walk;
		let index = holds("questions")
				&& walk !== undefined
				&& walk.widget === widget
				&& walk.question === question
			? (walk.index + 1) % places.length
			: 0;

		let place = places[index];
		if (!place) return;

		this.#walk = { widget, question, index };
		pin(editor, "questions", [place]);
		scrollToKey(editor, place.anchorKey);
	}

	/** Stop previewing. Whatever was pinned stays, which is what a pin is for. */
	clear(): void {
		if (this.#editor) paint(this.#editor, "questions", []);
	}

	/** Stop pointing at anything at all. The pane is going away. */
	release(): void {
		unpin(this.#editor, "questions");
		this.clear();
	}

	/** The blocks a decision resolves to, or nothing if it names none. */
	#places(widget: string, question: string): Points[] | undefined {
		let editor = this.#editor;
		if (!editor) return undefined;

		let found = this.#related.find(item => item.widget === widget && item.question === question);
		// Pending means nobody has checked this since the plan moved, so it is
		// not somewhere worth sending a reader.
		if (!found || found.pending) return undefined;

		let places: Points[] = [];
		editor.getEditorState().read(() => {
			for (let key of found.keys) {
				let points = $blockPoints(key);
				if (points) places.push(points);
			}
		});

		return places;
	}
}

/** Mounted inside the editor, so it can read the document as it changes. */
export function QuestionnaireObserver({ store }: { store: QuestionnaireStore }) {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		store.attach(editor);
		let read = () => editor.getEditorState().read(() => store.set(collectPlanState()));
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

export function useHasPlanContent(store: QuestionnaireStore): boolean {
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	return useSyncExternalStore(subscribe, store.contentSnapshot, store.contentSnapshot);
}
