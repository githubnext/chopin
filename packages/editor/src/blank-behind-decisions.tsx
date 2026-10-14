/**
 * The writing prompt below a protected title when no body prose is visible.
 * The derived overlay stays outside Lexical and follows the first body paragraph,
 * including a document whose only remaining body blocks are hidden decisions.
 */

import { createPortal } from "react-dom";
import { useEffect, useState, useSyncExternalStore } from "react";
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
	let hidden = blankBehindDecisions(
		entries,
		cards,
		writingEntries(entries, cards, questions, planner),
	);
	let blank = !content && (entries.length === 0 || hidden);
	let [target, setTarget] = useState<HTMLElement>();
	let [position, setPosition] = useState<{ top: number; left: number; width: number }>();
	useEffect(() => {
		let root = editor?.getRootElement();
		let host = root?.parentElement;
		if (!root || !host || !blank) return;
		setTarget(host);
		let place = () => {
			let body = root.querySelector<HTMLElement>(":scope > p");
			if (!body || !root.querySelector("[data-document-title]")) {
				setPosition(undefined);
				return;
			}
			let box = body.getBoundingClientRect();
			let parent = host.getBoundingClientRect();
			let next = {
				top: box.top - parent.top + host.scrollTop,
				left: box.left - parent.left + host.scrollLeft,
				width: box.width,
			};
			if (![next.top, next.left, next.width].every(Number.isFinite)) {
				setPosition(undefined);
				return;
			}
			setPosition(previous =>
				previous?.top === next.top && previous.left === next.left
					&& previous.width === next.width
					? previous
					: next
			);
		};
		let resize = new ResizeObserver(place);
		resize.observe(root);
		let mutation = new MutationObserver(place);
		mutation.observe(root, { attributes: true, childList: true, subtree: true });
		place();
		return () => {
			resize.disconnect();
			mutation.disconnect();
			setTarget(undefined);
			setPosition(undefined);
		};
	}, [blank, editor]);
	useEffect(() => {
		let root = editor?.getRootElement();
		if (!root || !blank) return;
		root.setAttribute("data-plan-blank", "");
		return () => {
			root.removeAttribute("data-plan-blank");
		};
	}, [blank, editor]);
	// Nothing visible to delete: Lexical would remove the caret's empty line and leave a block
	// cursor beside a decision the reader cannot see.
	useEffect(() => {
		if (!editor || content || !hidden) return;
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
	}, [content, editor, hidden]);
	return blank && target && position
		? createPortal(
			<div aria-hidden="true" className="plan-content plan-body-placeholder" style={position}>
				{placeholder}
			</div>,
			target,
		)
		: null;
}
