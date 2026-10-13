/**
 * The empty-document placeholder, for a document whose only blocks are decisions it hides.
 *
 * A decided card without prose keeps its projection node but draws nothing, and
 * Lexical shows no placeholder beside a decorator node. This marks the editable
 * root instead, and the stylesheet draws the same words in its first empty
 * paragraph, where a click puts the caret.
 */

import { useEffect, useSyncExternalStore } from "react";

import { useRelations } from "./questionnaires";
import { blankBehindDecisions, writingEntries } from "./widgets/questionnaire";

import type { CardMetaStore } from "./card-meta";
import type { LexicalEditor } from "lexical";
import type { QuestionnaireStore } from "./questionnaires";

const NO_CARDS = new Map();
const noCards = () => NO_CARDS;
const noop = () => () => {};

export function BlankBehindDecisions(
	{ cardMeta, editor, placeholder, planner, questions }: {
		cardMeta?: CardMetaStore;
		editor?: LexicalEditor;
		placeholder: string;
		planner?: boolean;
		questions: QuestionnaireStore;
	},
) {
	let entries = useSyncExternalStore(questions.subscribe, questions.snapshot, questions.snapshot);
	let content = useSyncExternalStore(
		questions.subscribe,
		questions.contentSnapshot,
		questions.contentSnapshot,
	);
	let cards = useSyncExternalStore(
		cardMeta?.subscribe ?? noop,
		cardMeta?.snapshot ?? noCards,
		cardMeta?.snapshot ?? noCards,
	);
	useRelations(questions);
	let blank = !content
		&& blankBehindDecisions(entries, cards, writingEntries(entries, cards, questions, planner));
	useEffect(() => {
		let root = editor?.getRootElement();
		if (!root || !blank) return;
		root.setAttribute("data-plan-blank", "");
		root.style.setProperty("--plan-blank-placeholder", JSON.stringify(placeholder));
		return () => {
			root.removeAttribute("data-plan-blank");
			root.style.removeProperty("--plan-blank-placeholder");
		};
	}, [blank, editor, placeholder]);
	return null;
}
