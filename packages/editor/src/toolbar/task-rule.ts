/**
 * `- [ ] ` at the start of a line becomes a task item.
 *
 * `[] `, `[ ] ` and `[x] ` already do, through the markdown shortcuts. The
 * dash form cannot: `- ` turns the line into a bullet the moment the space is
 * typed, so by the time `[ ]` follows there is no line start left to match.
 * This runs on the next space instead, and lifts the item out of its bullet
 * list into a task list.
 */

import { $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import {
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	KEY_DOWN_COMMAND,
} from "lexical";

import type { ListItemNode } from "@lexical/list";
import type { LexicalEditor } from "lexical";

/** The task marker a bullet item's text opens with: undefined, or whether it is checked. */
export function taskMarker(text: string): { checked: boolean } | undefined {
	let match = /^\[( |x)?\]$/i.exec(text);
	if (!match) return undefined;
	return { checked: match[1]?.toLowerCase() === "x" };
}

/** Give the item a task list of its own, splitting the bullet list it sits in. */
function $liftIntoTaskList(item: ListItemNode, checked: boolean): boolean {
	let list = item.getParent();
	if (!$isListNode(list) || list.getListType() !== "bullet") return false;

	let before = item.getPreviousSiblings();
	let after = item.getNextSiblings();
	let nested = $isListItemNode(list.getParent());

	if (before.length === 0 && after.length === 0) {
		list.setListType("check");
	} else if (nested) {
		// A split would leave a list beside a list inside the wrapper item.
		return false;
	} else {
		let tasks = $createListNode("check");
		if (before.length === 0) {
			list.insertBefore(tasks);
		} else {
			list.insertAfter(tasks);
			if (after.length > 0) {
				let rest = $createListNode("bullet");
				rest.append(...after);
				tasks.insertAfter(rest);
			}
		}
		tasks.append(item);
	}
	item.setChecked(checked);
	return true;
}

/** Commands run inside an update, so the handler reads and writes the tree directly. */
export function registerTaskRule(editor: LexicalEditor): () => void {
	return editor.registerCommand(
		KEY_DOWN_COMMAND,
		(event: KeyboardEvent) => {
			if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return false;
			if (event.isComposing) return false;

			let selection = $getSelection();
			if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
			let node = selection.anchor.getNode();
			if (!$isTextNode(node)) return false;
			let item = node.getParent();
			if (!$isListItemNode(item) || item.getFirstChild() !== node) return false;

			let offset = selection.anchor.offset;
			let marker = taskMarker(node.getTextContent().slice(0, offset));
			if (!marker || !$liftIntoTaskList(item, marker.checked)) return false;

			node.setTextContent(node.getTextContent().slice(offset));
			// An empty text child is normalised away; keep the caret on the item.
			if (node.getTextContentSize() === 0) item.select(0, 0);
			else node.select(0, 0);
			event.preventDefault();
			return true;
		},
		COMMAND_PRIORITY_LOW,
	);
}
