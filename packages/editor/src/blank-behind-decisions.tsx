/**
 * The empty-document placeholder, for a document whose only blocks are decisions it hides.
 *
 * A decided card without prose keeps its projection node but draws nothing, and
 * Lexical shows no placeholder beside a decorator node. This marks the editable
 * root instead, and the stylesheet draws the same words in its first empty
 * paragraph, where a click puts the caret.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_HIGH,
	KEY_BACKSPACE_COMMAND,
	KEY_DELETE_COMMAND,
} from "lexical";
import { $isDocumentTitle } from "./document-title";

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
	// Nothing visible to delete: Lexical would remove the caret's empty line and leave a block
	// cursor beside a decision the reader cannot see.
	useEffect(() => {
		if (!editor || !blank) return;
		let refuse = (event: KeyboardEvent | null) => {
			let selection = $getSelection();
			if ($isRangeSelection(selection)) {
				let node = selection.anchor.getNode();
				if ($isDocumentTitle(node) || $isDocumentTitle(node.getTopLevelElement())) return false;
			}
			event?.preventDefault();
			return true;
		};
		let offBackspace = editor.registerCommand(KEY_BACKSPACE_COMMAND, refuse, COMMAND_PRIORITY_HIGH);
		let offDelete = editor.registerCommand(KEY_DELETE_COMMAND, refuse, COMMAND_PRIORITY_HIGH);
		return () => {
			offBackspace();
			offDelete();
		};
	}, [blank, editor]);
	return null;
}
