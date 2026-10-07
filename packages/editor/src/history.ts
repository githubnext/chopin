/**
 * Undo and redo for one person in a shared document.
 *
 * Lexical's own history is suppressed because it would replay whole editor
 * states and so revert everybody's work. A Yjs `UndoManager` that tracks only
 * this binding's transactions undoes this person's edits and leaves peers' and
 * the Planner's alone, because those arrive under the provider's origin.
 *
 * Three things keep that from undoing more than the person did:
 *
 * - Edits this client makes in reaction to a remote change are not theirs.
 *   MDXEditor appends a paragraph whenever a card ends the document, and every
 *   client does so when the server appends one; undoing that would remove a
 *   paragraph somebody else may be typing in, and MDXEditor would put it back.
 * - A block this person created can hold other people's text by the time it is
 *   undone. Yjs would delete the block and their text with it; it stays, and
 *   only this person's part of it goes.
 * - The server refuses any browser batch that drops, alters or restores a
 *   Questionnaire, Decision or Research projection, and a refused batch costs
 *   everybody a rebuilt epoch. A step that inserted, moved or removed one (a
 *   `/research` reference, a dragged decision) cannot be reversed safely, so it
 *   ends the history instead of running.
 */

import { COMMAND_PRIORITY_EDITOR, REDO_COMMAND, UNDO_COMMAND } from "lexical";
import * as Y from "yjs";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";

/** Lexical types of the components whose records live outside the document. */
const PROTECTED = new Set(["plan-questionnaire", "plan-decision", "plan-research"]);

type StackItem = Y.UndoManager["undoStack"][number];
type DeleteSet = StackItem["insertions"];

function projection(type: Y.AbstractType<any>): boolean {
	if (!(type instanceof Y.XmlElement)) return false;
	// Read past deletion: a removed element's attributes are deleted with it,
	// and restoring a removed projection is one of the cases being asked about.
	let attribute = type._map.get("__type");
	return PROTECTED.has(attribute?.content.getContent()[0] as string);
}

/** Whether this item is a projection or sits inside one. */
function within(item: Y.Item): boolean {
	if (item.content instanceof Y.ContentType && projection(item.content.type)) return true;
	let parent = item.parent;
	while (parent instanceof Y.AbstractType) {
		if (projection(parent)) return true;
		parent = parent._item?.parent ?? null;
	}
	return false;
}

/** Whether deleting this item would delete live content another client wrote. */
function foreign(doc: Y.Doc, item: Y.Item): boolean {
	if (!(item.content instanceof Y.ContentType)) return false;
	if (item.content.type instanceof Y.Map) {
		// A text node is its property map followed by its characters, and a
		// peer typing at its end extends the run rather than starting a node.
		// Without the map Lexical has nowhere to put their characters.
		for (let next = item.right; next; next = next.right) {
			if (next.content instanceof Y.ContentType) break;
			if (!next.deleted && next.id.client !== doc.clientID) return true;
		}
		return false;
	}
	for (let child = item.content.type._start; child; child = child.right) {
		if (child.deleted) continue;
		if (child.id.client !== doc.clientID || foreign(doc, child)) return true;
	}
	return false;
}

function some(doc: Y.Doc, set: DeleteSet, test: (item: Y.Item) => boolean): boolean {
	for (let [client, ranges] of set.clients) {
		let structs = doc.store.clients.get(client);
		if (!structs) continue;
		for (let { clock, len } of ranges) {
			for (let index = Y.findIndexSS(structs, clock); index < structs.length; index++) {
				let struct = structs[index]!;
				if (struct.id.clock >= clock + len) break;
				if (struct instanceof Y.Item && test(struct)) return true;
			}
		}
	}
	return false;
}

/** Whether reversing this stack item would insert, remove or alter a projection. */
export function touchesProjection(doc: Y.Doc, item: StackItem): boolean {
	return some(doc, item.insertions, within) || some(doc, item.deletions, within);
}

/** An undo manager over `scope` for the transactions made under `origin`. */
export function planUndoManager(scope: Y.AbstractType<any>, origin: unknown): Y.UndoManager {
	let doc = scope.doc!;
	return new Y.UndoManager(scope, {
		trackedOrigins: new Set([origin]),
		deleteFilter: item => !foreign(doc, item),
	});
}

export type PlanHistory = {
	/** Leave out whatever this client writes until the current task has run. */
	react(): void;
	dispose(): void;
};

/**
 * Register undo and redo on an editor bound to a shared document.
 *
 * Bound to one Y.Doc, so an epoch rotation, which remounts the editor over a
 * fresh document, starts an empty history with it.
 */
export function registerPlanHistory(editor: LexicalEditor, binding: Binding): PlanHistory {
	let manager = planUndoManager(binding.root.getSharedType(), binding);
	let doc = binding.doc;

	let step = (direction: "undo" | "redo") => {
		if (!editor.isEditable()) return false;
		let stack = direction === "undo" ? manager.undoStack : manager.redoStack;
		let next = stack.at(-1);
		if (next && touchesProjection(doc, next)) {
			manager.clear(direction === "undo", direction === "redo");
		} else if (next) {
			manager[direction]();
		}
		return true;
	};

	let stopUndo = editor.registerCommand(UNDO_COMMAND, () => step("undo"), COMMAND_PRIORITY_EDITOR);
	let stopRedo = editor.registerCommand(REDO_COMMAND, () => step("redo"), COMMAND_PRIORITY_EDITOR);

	// Lexical commits a remote change in a microtask and its listeners react
	// synchronously from there, so a macrotask is past all of it.
	let quiet: ReturnType<typeof setTimeout> | undefined;
	let react = () => {
		manager.trackedOrigins.delete(binding);
		clearTimeout(quiet);
		quiet = setTimeout(() => manager.trackedOrigins.add(binding));
	};

	return {
		react,
		dispose() {
			clearTimeout(quiet);
			stopUndo();
			stopRedo();
			manager.destroy();
		},
	};
}
