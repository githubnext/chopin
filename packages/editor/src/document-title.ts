import { $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import {
	INSERT_CHECK_LIST_COMMAND,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$hasUpdateTag,
	$isDecoratorNode,
	$isElementNode,
	$isRangeSelection,
	$isRootNode,
	$isTextNode,
	$setSelection,
	COLLABORATION_TAG,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_HIGH,
	COMMAND_PRIORITY_NORMAL,
	CONTROLLED_TEXT_INSERTION_COMMAND,
	DELETE_CHARACTER_COMMAND,
	DELETE_LINE_COMMAND,
	DELETE_WORD_COMMAND,
	HISTORIC_TAG,
	INSERT_LINE_BREAK_COMMAND,
	INSERT_PARAGRAPH_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_DELETE_COMMAND,
	mergeRegister,
	PASTE_COMMAND,
	REMOVE_TEXT_COMMAND,
	RootNode,
} from "lexical";
import { boundDocumentTitle, MAX_TITLE_LENGTH } from "@chopin/dialect";
import { atBlockEnd, atBlockStart } from "./widgets/discarded-navigation-boundary";

import type { HeadingNode } from "@lexical/rich-text";
import type { LexicalEditor, LexicalNode, PointType } from "lexical";

function block(node: LexicalNode): LexicalNode {
	while (node.getParent() && !$isRootNode(node.getParent())) node = node.getParent()!;
	return node;
}

/** A title is not substantive body prose, including before the plugin has mounted. */
export function $isDocumentTitle(node: LexicalNode | null): boolean {
	return $isHeadingNode(node) && node.getTag() === "h1"
		&& $isRootNode(node.getParent()) && node.getPreviousSibling() === null;
}

function offset(title: HeadingNode, point: PointType): number | undefined {
	let node = point.getNode();
	if (block(node).getKey() !== title.getKey()) return undefined;
	if (node === title) return point.offset === 0 ? 0 : title.getTextContentSize();
	let count = 0;
	for (let text of title.getAllTextNodes()) {
		if (text.getKey() === point.key) return count + point.offset;
		count += text.getTextContentSize();
	}
	return count;
}

/** Register only after the provider has confirmed its server-owned document. */
export function registerDocumentTitle(editor: LexicalEditor, canEdit = true): () => void {
	let key: string | undefined;
	let textKeys: string[] = [];
	let decorated: HTMLElement | null = null;
	function adopt() {
		let first = $getRoot().getFirstChild();
		key = $isDocumentTitle(first) ? first!.getKey() : undefined;
		textKeys = $isHeadingNode(first) && key ? first.getAllTextNodes().map(n => n.getKey()) : [];
	}
	editor.getEditorState().read(adopt);
	function title(): HeadingNode | undefined {
		let node = key ? $getNodeByKey(key) : null;
		return $isHeadingNode(node) && node.isAttached() ? node : undefined;
	}
	function inside() {
		let selection = $getSelection();
		let heading = title();
		return heading && $isRangeSelection(selection)
				&& block(selection.anchor.getNode()).getKey() === key
				&& block(selection.focus.getNode()).getKey() === key
			? { heading, selection }
			: undefined;
	}
	function leave(): boolean {
		let found = canEdit && inside();
		if (!found) return false;
		let next = found.heading.getNextSibling();
		if (!$isElementNode(next) || next.getType() !== "paragraph") {
			next = $createParagraphNode();
			found.heading.insertAfter(next);
		}
		(next as ReturnType<typeof $createParagraphNode>).selectStart();
		return true;
	}
	function crossing() {
		let selection = $getSelection();
		let heading = title();
		if (!canEdit || !heading || !$isRangeSelection(selection) || selection.isCollapsed()) return;
		let start = selection.isBackward() ? selection.focus : selection.anchor;
		let end = selection.isBackward() ? selection.anchor : selection.focus;
		let node = start.getNode();
		if (block(node).getKey() !== key && !($isRootNode(node) && start.offset === 0)) return;
		let nodes = selection.getNodes();
		if (!nodes.some(n => !$isRootNode(n) && block(n).getKey() !== key)) return;
		return { heading, selection, start, end, blocked: nodes.some($isDecoratorNode) };
	}
	function removeAcross(): boolean {
		let found = crossing();
		if (!found) return false;
		if (found.blocked) return true;
		let { heading, selection, start, end } = found;
		let titleSelection = selection.clone();
		if ($isRootNode(start.getNode())) titleSelection.anchor.set(heading.getKey(), 0, "element");
		else titleSelection.anchor.set(start.key, start.offset, start.type);
		titleSelection.focus.set(heading.getKey(), heading.getChildrenSize(), "element");
		let body = heading.getNextSibling();
		if ($isElementNode(body)) {
			let bodySelection = selection.clone();
			bodySelection.anchor.set(body.getKey(), 0, "element");
			bodySelection.focus.set(end.key, end.offset, end.type);
			$setSelection(bodySelection);
			bodySelection.removeText();
		}
		$setSelection(titleSelection);
		titleSelection.removeText();
		return true;
	}
	function boundary(backward: boolean): boolean {
		if (!canEdit) return false;
		let selection = $getSelection();
		let heading = title();
		if (!heading || !$isRangeSelection(selection) || !selection.isCollapsed()) return false;
		let point = selection.anchor;
		let node = point.getNode();
		if ($isRootNode(node)) return point.offset <= 1;
		let current = block(node);
		let start = point.offset === 0 && atBlockStart(node);
		let end = point.offset === ($isTextNode(node)
					? node.getTextContentSize()
					: $isElementNode(node)
					? node.getChildrenSize()
					: -1) && atBlockEnd(node);
		return current.getKey() === key
			? backward ? start : end
			: backward && start && current.getPreviousSibling()?.getKey() === key;
	}
	function insert(value: string): boolean {
		if (editor.isComposing()) return false;
		if (crossing()?.blocked) return true;
		removeAcross();
		let found = canEdit && inside();
		if (!found) return false;
		let { heading, selection } = found;
		let remaining = MAX_TITLE_LENGTH - [...heading.getTextContent()].length
			+ [...selection.getTextContent()].length;
		selection.insertText([...boundDocumentTitle(value)].slice(0, Math.max(0, remaining)).join(""));
		return true;
	}
	function decorate() {
		if (typeof document === "undefined") return;
		let heading = title();
		let element = heading ? editor.getElementByKey(heading.getKey()) : null;
		if (decorated !== element) {
			decorated?.removeAttribute("data-document-title");
			decorated?.removeAttribute("data-document-title-empty");
			decorated = element;
		}
		if (!element || !heading) return;
		element.setAttribute("data-document-title", "");
		element.toggleAttribute("data-document-title-empty", heading.getTextContentSize() === 0);
	}
	let off = mergeRegister(
		editor.registerNodeTransform(RootNode, root => {
			if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) {
				// Server replacement and Yjs undo already contain the canonical invariant.
				adopt();
				return;
			}
			if (!key || !canEdit) return;
			let heading = title();
			if (!heading) {
				let moved = textKeys.map(k => $getNodeByKey(k)).find(n => n?.isAttached());
				let replacement = moved ? block(moved) : undefined;
				let old = $getNodeByKey(key);
				heading = $isHeadingNode(old) ? old : $createHeadingNode("h1");
				if ($isElementNode(replacement) && !$isRootNode(replacement)) {
					// A list or callout can also hold body blocks. Recover only the title's inline run.
					let carrier = moved!;
					while (!$isElementNode(carrier) || carrier.isInline()) {
						carrier = carrier.getParentOrThrow();
					}
					let parents = carrier.getParents().filter(parent => !$isRootNode(parent));
					let inline = carrier.getChildren().filter(node => node.isInline());
					heading.append(...inline);
					replacement.insertBefore(heading);
					let selection = $getSelection();
					if ($isRangeSelection(selection)) {
						for (let point of [selection.anchor, selection.focus]) {
							if (point.key === carrier.getKey()) {
								point.set(heading.getKey(), Math.min(point.offset, inline.length), "element");
							}
						}
					}
					if (carrier.getChildrenSize() === 0) carrier.remove();
					for (let parent of parents) {
						if (parent.isAttached() && parent.getChildrenSize() === 0) parent.remove();
					}
				} else {
					heading.clear();
					let first = root.getFirstChild();
					if (first) first.insertBefore(heading);
					else root.append(heading);
				}
				key = heading.getKey();
			}
			if (heading.getTag() !== "h1") heading.setTag("h1");
			if (root.getFirstChild()?.getKey() !== key) root.getFirstChild()!.insertBefore(heading);
			let value = heading.getTextContent();
			let bounded = boundDocumentTitle(value);
			if (value !== bounded && !editor.isComposing()) {
				let selection = $getSelection();
				let anchor = $isRangeSelection(selection) ? offset(heading, selection.anchor) : undefined;
				let focus = $isRangeSelection(selection) ? offset(heading, selection.focus) : undefined;
				let text = $createTextNode(bounded);
				heading.clear().append(text);
				if ($isRangeSelection(selection)) {
					if (anchor !== undefined) {
						selection.anchor.set(text.getKey(), Math.min(anchor, bounded.length), "text");
					}
					if (focus !== undefined) {
						selection.focus.set(text.getKey(), Math.min(focus, bounded.length), "text");
					}
				}
			}
			textKeys = heading.getAllTextNodes().map(n => n.getKey());
		}),
		editor.registerUpdateListener(({ editorState }) => editorState.read(decorate)),
		typeof document === "undefined"
			? () => {}
			: editor.registerRootListener(() => editor.getEditorState().read(decorate)),
		editor.registerCommand(INSERT_PARAGRAPH_COMMAND, leave, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(INSERT_LINE_BREAK_COMMAND, leave, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(
			INSERT_UNORDERED_LIST_COMMAND,
			() => canEdit && !!inside(),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			INSERT_ORDERED_LIST_COMMAND,
			() => canEdit && !!inside(),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			INSERT_CHECK_LIST_COMMAND,
			() => canEdit && !!inside(),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(DELETE_CHARACTER_COMMAND, boundary, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(DELETE_WORD_COMMAND, boundary, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(DELETE_LINE_COMMAND, boundary, COMMAND_PRIORITY_HIGH),
		// Protected projections get first refusal at HIGH before a spanning range is split.
		editor.registerCommand(DELETE_CHARACTER_COMMAND, removeAcross, COMMAND_PRIORITY_NORMAL),
		editor.registerCommand(DELETE_WORD_COMMAND, removeAcross, COMMAND_PRIORITY_NORMAL),
		editor.registerCommand(DELETE_LINE_COMMAND, removeAcross, COMMAND_PRIORITY_NORMAL),
		editor.registerCommand(REMOVE_TEXT_COMMAND, removeAcross, COMMAND_PRIORITY_NORMAL),
		editor.registerCommand(KEY_BACKSPACE_COMMAND, event => {
			if (!boundary(true)) return false;
			event?.preventDefault();
			return true;
		}, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(KEY_DELETE_COMMAND, event => {
			if (!boundary(false)) return false;
			event?.preventDefault();
			return true;
		}, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, value => {
			let text = typeof value === "string"
				? value
				: value.dataTransfer?.getData("text/plain") ?? value.data;
			return text === null || text === undefined ? false : insert(text);
		}, COMMAND_PRIORITY_HIGH),
		editor.registerCommand(PASTE_COMMAND, event => {
			if (!event || !("clipboardData" in event)) return false;
			let text = event.clipboardData?.getData("text/plain");
			if (text === undefined || !insert(text)) return false;
			event.preventDefault();
			return true;
		}, COMMAND_PRIORITY_CRITICAL),
	);
	return () => {
		off();
		decorated?.removeAttribute("data-document-title");
		decorated?.removeAttribute("data-document-title-empty");
	};
}
