/**
 * The Chat draft as rich text, as Slack's message box draws it: bold, italic and struck words,
 * links, lists, inline code and code blocks render as they are written, from the toolbar, Slack's
 * keys and Slack's typed marks. It is Lexical, the editor the documents use, and is loaded with
 * the first composer rather than with the page.
 *
 * What `Chat` holds and sends is unchanged: the draft's Markdown, its references over that text,
 * and a selection in offsets of it. This field is told that Markdown and draws what it means
 * (`draft-markdown.ts` reads and writes it), and tells `Chat` the Markdown each edit makes. A
 * change `Chat` makes itself (a chosen mention or chip, dictated words, a restored or cleared
 * draft) is applied as the edit it is where it falls inside one run of words, so the marks round
 * it are kept, and otherwise read again whole.
 */

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { $createLinkNode, $isLinkNode, $toggleLink, LinkNode } from "@lexical/link";
import {
	$createListItemNode,
	$createListNode,
	$isListItemNode,
	$isListNode,
	ListItemNode,
	ListNode,
	registerList,
} from "@lexical/list";
import { registerRichText } from "@lexical/rich-text";
import { $findMatchingParent, mergeRegister } from "@lexical/utils";
import {
	$createLineBreakNode,
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$insertNodes,
	$isElementNode,
	$isLineBreakNode,
	$isParagraphNode,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
	CLEAR_HISTORY_COMMAND,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_HIGH,
	CONTROLLED_TEXT_INSERTION_COMMAND,
	createEditor,
	FORMAT_TEXT_COMMAND,
	HISTORIC_TAG,
	HISTORY_PUSH_TAG,
	INDENT_CONTENT_COMMAND,
	INSERT_PARAGRAPH_COMMAND,
	PASTE_COMMAND,
	SKIP_DOM_SELECTION_TAG,
	TextNode,
} from "lexical";

import { contiguousReplacement, referenceTargetKey } from "../references";
import { parseDraft, serializeDraft } from "./draft-markdown";
import {
	$codeText,
	$offsetPoint,
	$pointOffset,
	$readBlocks,
	$selectOffsets,
	$writeBlocks,
	slotIndex,
} from "./editor-blocks";
import {
	$createChipNode,
	$createCodeBlockNode,
	$createMentionNode,
	$isChipNode,
	$isCodeBlockNode,
	$isInterimNode,
	$isMentionNode,
	ChipNode,
	CodeBlockNode,
	InterimNode,
	MentionNode,
} from "./nodes";
import { formatShortcut, typedBlock, typedInline } from "./shortcuts";

import type { ListType } from "@lexical/list";
import type { KeyboardEvent } from "react";
import type {
	BaseSelection,
	EditorState,
	ElementNode,
	LexicalEditor,
	LexicalNode,
	TextFormatType,
} from "lexical";
import type { DraftInputHandle, DraftInputProps } from "../draft-input";
import type { Format } from "../format";
import type { ReferenceDraft } from "../references";
import type { ReferencePayload } from "./draft-markdown";
import type { SlotIndex } from "./editor-blocks";

export type RichDraftHandle = DraftInputHandle & {
	/** Applies a mark of the toolbar or of a key to the selection, as Slack's message box does. */
	format: (kind: Exclude<Format, "link">) => void;
	/** The address of the link at the selection, if it is in one. */
	linkAddress: () => string | undefined;
	/** Keeps the selection while the link's address is asked for outside the draft. */
	holdSelection: () => void;
	/**
	 * Makes the held selection a link to `url`, or no link with `null`, and returns to the draft;
	 * with `undefined` only returns, the selection as it was.
	 */
	setLink: (url: string | null | undefined) => void;
};

export type RichDraftInputProps = DraftInputProps & {
	/** The marks at the caret, for the toolbar to show pressed. */
	onFormats?: (active: ReadonlySet<Format>) => void;
	/** A link is asked for, by Cmd+K or Ctrl+K. */
	onLink?: () => void;
};

/** An update the field makes from what `Chat` told it, rather than from what was typed. */
const EXTERNAL_TAG = "chat-external";
const INTERIM_TAG = "chat-interim";

const THEME = {
	paragraph: "draft-paragraph",
	link: "draft-link",
	list: {
		ul: "draft-list",
		ol: "draft-list draft-list-ordered",
		listitem: "draft-list-item",
		nested: { listitem: "draft-list-nested" },
	},
	text: {
		bold: "draft-bold",
		italic: "draft-italic",
		strikethrough: "draft-strike",
		code: "draft-code",
	},
};

const TEXT_FORMATS: Record<"bold" | "italic" | "strike" | "code", TextFormatType> = {
	bold: "bold",
	italic: "italic",
	strike: "strikethrough",
	code: "code",
};

/** The same references at the same places, in whatever order they are listed. */
function sameReferences(
	left: readonly ReferenceDraft[],
	right: readonly ReferenceDraft[],
): boolean {
	let order = (list: readonly ReferenceDraft[]) => [...list].sort((a, b) => a.start - b.start);
	let sorted = order(right);
	return left.length === right.length && order(left).every((reference, index) => {
		let other = sorted[index]!;
		return reference.start === other.start && reference.end === other.end
			&& reference.token === other.token
			&& referenceTargetKey(reference) === referenceTargetKey(other);
	});
}

function $index(): SlotIndex {
	return slotIndex(serializeDraft($readBlocks()));
}

function $topBlock(node: LexicalNode): LexicalNode {
	let block = node;
	while (block.getParent() && block.getParent() !== $getRoot()) block = block.getParent()!;
	return block;
}

function $selectionOffsets(index: SlotIndex): { start: number; end: number } {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return { start: 0, end: 0 };
	let anchor = $pointOffset(selection.anchor, index);
	let focus = $pointOffset(selection.focus, index);
	return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

function $activeFormats(): Set<Format> {
	let active = new Set<Format>();
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return active;
	let node = selection.anchor.getNode();
	if ($findMatchingParent(node, $isCodeBlockNode)) {
		active.add("block");
		return active;
	}
	for (let [kind, format] of Object.entries(TEXT_FORMATS)) {
		if (selection.hasFormat(format)) active.add(kind as Format);
	}
	if ($findMatchingParent(node, $isLinkNode)) active.add("link");
	let list = $findMatchingParent(node, $isListNode);
	if ($isListNode(list)) active.add(list.getListType() === "number" ? "numbered" : "bulleted");
	return active;
}

/** The blocks a selection touches, in the order they come. */
function $selectedBlocks(): LexicalNode[] {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return [];
	let first = $topBlock(selection.anchor.getNode());
	let last = $topBlock(selection.focus.getNode());
	if (first.isBefore(last) === false && first !== last) [first, last] = [last, first];
	let blocks = [first];
	let node: LexicalNode | null = first;
	while (node !== last && (node = node.getNextSibling())) blocks.push(node);
	return blocks;
}

/** The lines of a block, each as its own nodes: a paragraph's between its breaks, a list's items. */
function $blockLines(block: LexicalNode): LexicalNode[][] {
	if ($isListNode(block)) {
		return block.getChildren().map(item => $isElementNode(item) ? item.getChildren() : []);
	}
	if ($isCodeBlockNode(block)) {
		return $codeText(block).split("\n").map(line => line ? [$createTextNode(line)] : []);
	}
	if (!$isElementNode(block)) return [[block]];
	let lines: LexicalNode[][] = [[]];
	for (let child of block.getChildren()) {
		if ($isLineBreakNode(child)) lines.push([]);
		else lines.at(-1)!.push(child);
	}
	return lines;
}

/**
 * Every line the selection touches as an item of a list of this type, as Slack's toolbar makes
 * one; or, where they all are one already, each item a line of its own again.
 */
function $toggleList(type: ListType): void {
	let blocks = $selectedBlocks();
	if (blocks.length === 0) return;
	let current = $getSelection();
	let collapsed = !$isRangeSelection(current) || current.isCollapsed();
	let made: ElementNode[] = [];
	if (blocks.every(block => $isListNode(block) && block.getListType() === type)) {
		for (let block of blocks) {
			for (let line of $blockLines(block)) {
				let paragraph = $createParagraphNode().append(...line);
				block.insertBefore(paragraph);
				made.push(paragraph);
			}
			block.remove();
		}
	} else {
		let list = $createListNode(type);
		for (let block of blocks) {
			for (let line of $blockLines(block)) {
				let item = $createListItemNode().append(...line);
				list.append(item);
				made.push(item);
			}
		}
		blocks[0]!.insertBefore(list);
		for (let block of blocks) block.remove();
	}
	// The lines stay chosen, so the next mark takes them all.
	let last = made.at(-1)!;
	if (collapsed) {
		last.selectEnd();
		return;
	}
	let { key, offset, type: kind } = last.selectEnd().focus;
	made[0]!.selectStart().focus.set(key, offset, kind);
}

/** The selected blocks as one code block of their words, or a code block as a paragraph again. */
function $toggleCodeBlock(): void {
	let blocks = $selectedBlocks();
	if (blocks.length === 0) return;
	if (blocks.every($isCodeBlockNode)) {
		for (let block of blocks as ElementNode[]) block.collapseAtStart($getSelection() as never);
		return;
	}
	let lines = blocks.map(block =>
		$isListNode(block)
			? block.getChildren().map(item => item.getTextContent()).join("\n")
			: $isCodeBlockNode(block)
			? $codeText(block)
			: block.getTextContent()
	);
	let code = $createCodeBlockNode();
	for (let [index, line] of lines.join("\n").split("\n").entries()) {
		if (index > 0) code.append($createLineBreakNode());
		if (line) code.append($createTextNode(line));
	}
	blocks[0]!.replace(code);
	for (let block of blocks.slice(1)) block.remove();
	code.selectEnd();
}

/** Shift+Enter: a new item in a list, a new line in a code block or a paragraph. */
function $breakLine(editor: LexicalEditor): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let node = selection.anchor.getNode();
	if ($findMatchingParent(node, $isListItemNode)) {
		editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
		return;
	}
	let code = $findMatchingParent(node, $isCodeBlockNode);
	if ($isElementNode(code) && selection.isCollapsed()) {
		let last = code.getLastChild();
		let atEnd = selection.anchor.type === "element"
			? selection.anchor.key === code.getKey() && selection.anchor.offset === code.getChildrenSize()
			: false;
		// A second Shift+Enter on an empty last line leaves the block, as Slack's does.
		if (atEnd && $isLineBreakNode(last)) {
			last.remove();
			let paragraph = $createParagraphNode();
			code.insertAfter(paragraph);
			paragraph.select();
			return;
		}
	}
	selection.insertLineBreak();
}

/** The typed marks just closed before the caret, made into the format they mean. */
function $typedShortcut(key: string, offset: number): void {
	let node = $getNodeByKey(key);
	if (!$isTextNode(node) || !node.isSimpleText() || $findMatchingParent(node, $isCodeBlockNode)) {
		return;
	}
	let text = node.getTextContent();
	let before = text.slice(0, offset);
	let inline = node.hasFormat("code") ? undefined : typedInline(before);
	if (inline) {
		let format = node.getFormat();
		let inner = text.slice(inline.open + inline.length, inline.close);
		let after = text.slice(offset);
		let formatted = $createTextNode(inner).setFormat(format).toggleFormat(
			TEXT_FORMATS[inline.format],
		);
		let rest = after ? $createTextNode(after).setFormat(format) : undefined;
		let lead = text.slice(0, inline.open);
		if (lead) {
			node.setTextContent(lead);
			node.insertAfter(formatted);
		} else node.replace(formatted);
		if (rest) formatted.insertAfter(rest);
		formatted.select(inner.length, inner.length);
		// What is typed next is not in the format.
		let selection = $getSelection();
		if ($isRangeSelection(selection)) selection.format = format;
		return;
	}
	let parent = node.getParent();
	let previous = node.getPreviousSibling();
	if (!$isParagraphNode(parent) || (previous && !$isLineBreakNode(previous))) return;
	let block = typedBlock(before);
	if (!block) return;
	// The line becomes the block: the lines before it stay a paragraph, the rest go with it.
	node.spliceText(0, offset, "");
	let paragraph = parent;
	if (previous) {
		paragraph = $createParagraphNode();
		let moving: LexicalNode[] = [];
		for (let sibling: LexicalNode | null = node; sibling; sibling = sibling.getNextSibling()) {
			moving.push(sibling);
		}
		paragraph.append(...moving);
		previous.remove();
		parent.insertAfter(paragraph);
	}
	if (block.kind === "block") {
		let code = $createCodeBlockNode();
		for (let [index, line] of $codeLinesOf(paragraph).entries()) {
			if (index > 0) code.append($createLineBreakNode());
			if (line) code.append($createTextNode(line));
		}
		paragraph.replace(code);
		code.selectStart();
		return;
	}
	let type: ListType = block.kind === "numbered" ? "number" : "bullet";
	let item = $createListItemNode();
	item.append(...paragraph.getChildren());
	let earlier = paragraph.getPreviousSibling();
	if ($isListNode(earlier) && earlier.getListType() === type) {
		earlier.append(item);
		paragraph.remove();
	} else {
		let list = $createListNode(type, block.kind === "numbered" ? block.start : 1);
		list.append(item);
		paragraph.replace(list);
	}
	item.selectStart();
}

function $codeLinesOf(element: ElementNode): string[] {
	return $codeText(element).split("\n");
}

/** Marks `@login` for the people the draft knows, and unmarks what no longer is one. */
function registerMentions(editor: LexicalEditor, known: () => ReadonlySet<string>): () => void {
	let boundary = /[\w@]$/;
	return mergeRegister(
		editor.registerNodeTransform(TextNode, node => {
			if (
				!node.isSimpleText() || node.hasFormat("code")
				|| $findMatchingParent(node, $isCodeBlockNode)
			) {
				return;
			}
			let text = node.getTextContent();
			let previous = node.getPreviousSibling();
			let next = node.getNextSibling();
			// Words typed against a mention make it a different login.
			if ($isMentionNode(previous) && /^[\w-]/.test(text)) previous.markDirty();
			if ($isMentionNode(next) && boundary.test(text)) next.markDirty();
			for (let match of text.matchAll(/(^|[^\w@])(@[\w-]+)/g)) {
				let start = match.index + match[1]!.length;
				if (start === 0 && $isTextNode(previous) && boundary.test(previous.getTextContent())) {
					continue;
				}
				let token = match[2]!;
				if (!known().has(token.slice(1).toLowerCase())) continue;
				let end = start + token.length;
				if (end === text.length && $isTextNode(next) && /^[\w-]/.test(next.getTextContent())) {
					continue;
				}
				let parts = node.splitText(start, end);
				let target = parts[start === 0 ? 0 : 1]!;
				target.replace($createMentionNode(token).setFormat(node.getFormat()));
				return;
			}
		}),
		editor.registerNodeTransform(MentionNode, node => {
			let text = node.getTextContent();
			let previous = node.getPreviousSibling();
			let next = node.getNextSibling();
			let valid = /^@[\w-]+$/.test(text) && known().has(text.slice(1).toLowerCase())
				&& !($isTextNode(previous) && boundary.test(previous.getTextContent()))
				&& !($isTextNode(next) && /^[\w-]/.test(next.getTextContent()));
			if (!valid) node.replace($createTextNode(text).setFormat(node.getFormat()));
		}),
	);
}

/** Whether `next` is `previous` with one character typed at `offset - 1`. */
function typedOne(previous: string, next: string, offset: number): boolean {
	return next.length === previous.length + 1
		&& next.slice(0, offset - 1) + next.slice(offset) === previous;
}

function $textIn(prior: EditorState, key: string): string | undefined {
	return prior.read(() => {
		let node = $getNodeByKey(key);
		return $isTextNode(node) ? node.getTextContent() : undefined;
	});
}

export let RichDraftInput = forwardRef<RichDraftHandle, RichDraftInputProps>(
	function RichDraftInput(
		props,
		ref,
	) {
		let {
			value,
			references,
			mentions,
			readOnly,
			placeholder,
			resetKey,
			interim,
			role,
			"aria-label": label,
			"aria-disabled": disabled,
			"aria-invalid": invalid,
			"aria-describedby": describedBy,
			"aria-autocomplete": autocomplete,
			"aria-expanded": expanded,
			"aria-controls": controls,
			"aria-activedescendant": activeDescendant,
		} = props;
		let root = useRef<HTMLDivElement>(null);
		let latest = useRef(props);
		latest.current = props;
		let known = useRef({ value, references });
		let index = useRef<SlotIndex>(slotIndex(serializeDraft([])));
		let selection = useRef({ start: 0, end: 0 });
		let formats = useRef("");
		let held = useRef<BaseSelection | null>(null);
		let breaking = useRef(false);
		// What `Chat` was last told, and the Markdown the field made of it, where the two differ: the
		// caret `Chat` puts next is in offsets of what it was told.
		let told = useRef<{ value: string; markdown: string } | undefined>(undefined);
		let logins = useRef<ReadonlySet<string>>(new Set());
		let historyKey = useRef(resetKey);
		let [editor] = useState(() =>
			createEditor({
				namespace: "chat-draft",
				theme: THEME,
				nodes: [
					ListNode,
					ListItemNode,
					LinkNode,
					ChipNode,
					MentionNode,
					CodeBlockNode,
					InterimNode,
				],
				onError: error => console.error("[chat] the draft's editor failed:", error),
			})
		);

		let mentionsKey = mentions.map(login => login.toLowerCase()).join("\0");
		logins.current = new Set(mentionsKey ? mentionsKey.split("\0") : []);

		// A change the person did not make in the draft never takes the focus from where they are.
		let away = () => document.activeElement === root.current ? [] : [SKIP_DOM_SELECTION_TAG];

		let mark = (markdown: string) => {
			let element = root.current;
			if (!element) return;
			if (!markdown && !latest.current.interim?.text) element.setAttribute("data-empty", "true");
			else element.removeAttribute("data-empty");
			element.dataset.chatRaw = markdown;
		};

		let emit = (tags: ReadonlySet<string>, state: EditorState, edited: boolean) => {
			let { next, offsets, active } = state.read(() => {
				let next = $index();
				return { next, offsets: $selectionOffsets(next), active: $activeFormats() };
			});
			index.current = next;
			let element = root.current;
			mark(next.serialized.markdown);
			if (!tags.has(EXTERNAL_TAG)) told.current = undefined;
			let activeKey = [...active].sort().join(" ");
			if (activeKey !== formats.current) {
				formats.current = activeKey;
				latest.current.onFormats?.(active);
			}
			let { markdown, references: made } = next.serialized;
			let selectionMoved = offsets.start !== selection.current.start
				|| offsets.end !== selection.current.end;
			selection.current = offsets;
			// Words typed over the same words are still an edit, which closes a menu put away.
			if (
				markdown !== known.current.value || !sameReferences(made, known.current.references)
				|| edited
			) {
				known.current = { value: markdown, references: made };
				latest.current.onChange({
					currentTarget: {
						value: markdown,
						references: made,
						selectionStart: offsets.start,
						selectionEnd: offsets.end,
					},
				});
			} else if (selectionMoved && document.activeElement === element && !tags.has(INTERIM_TAG)) {
				latest.current.onSelect({
					currentTarget: {
						value: markdown,
						selectionStart: offsets.start,
						selectionEnd: offsets.end,
					},
				});
			}
		};

		useLayoutEffect(() => {
			let element = root.current!;
			editor.setRootElement(element);
			let history = createEmptyHistoryState();
			editor.update(() => {
				$writeBlocks(parseDraft(known.current.value, known.current.references));
			}, { discrete: true, tag: HISTORIC_TAG });
			index.current = editor.getEditorState().read($index);
			mark(index.current.serialized.markdown);
			let unregister = mergeRegister(
				registerRichText(editor),
				registerHistory(editor, history, 300),
				registerList(editor),
				registerMentions(editor, () => logins.current),
				editor.registerUpdateListener(
					({ editorState, prevEditorState, tags, dirtyLeaves, dirtyElements }) => {
						let edited = (dirtyLeaves.size > 0 || dirtyElements.size > 0)
							&& ![HISTORIC_TAG, EXTERNAL_TAG, INTERIM_TAG].some(tag => tags.has(tag));
						emit(tags, editorState, edited);
						if (
							tags.has(HISTORIC_TAG) || tags.has(EXTERNAL_TAG) || tags.has(INTERIM_TAG)
							|| tags.has("paste") || editor.isComposing()
						) return;
						let typed = editorState.read(() => {
							let current = $getSelection();
							if (!$isRangeSelection(current) || !current.isCollapsed()) return undefined;
							let { key, offset, type } = current.anchor;
							if (type !== "text" || !dirtyLeaves.has(key) || offset === 0) return undefined;
							let node = $getNodeByKey(key);
							let before = $textIn(prevEditorState, key);
							if (!$isTextNode(node) || before === undefined) return undefined;
							return typedOne(before, node.getTextContent(), offset) ? { key, offset } : undefined;
						});
						if (typed) {
							editor.update(() => $typedShortcut(typed.key, typed.offset), {
								tag: HISTORY_PUSH_TAG,
							});
						}
					},
				),
				editor.registerCommand(INDENT_CONTENT_COMMAND, () => true, COMMAND_PRIORITY_CRITICAL),
				editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, () => {
					// A chip is one thing: words typed with the caret inside one go after it.
					let current = $getSelection();
					if (!$isRangeSelection(current) || !current.isCollapsed()) return false;
					let node = current.anchor.getNode();
					let length = node.getTextContentSize();
					if ($isChipNode(node) && current.anchor.offset > 0 && current.anchor.offset < length) {
						node.select(length, length);
					}
					return false;
				}, COMMAND_PRIORITY_CRITICAL),
				editor.registerCommand(FORMAT_TEXT_COMMAND, format => {
					// Markdown has no underline, and a code block's words are only words.
					let current = $getSelection();
					return !(format in { bold: 1, italic: 1, strikethrough: 1, code: 1 })
						|| ($isRangeSelection(current)
							&& !!$findMatchingParent(current.anchor.getNode(), $isCodeBlockNode));
				}, COMMAND_PRIORITY_CRITICAL),
				editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => {
					// Enter sends; only Shift+Enter in a list makes a new item, through this command.
					if (breaking.current) return false;
					if (!editor.isComposing()) latest.current.onSubmit();
					return true;
				}, COMMAND_PRIORITY_CRITICAL),
				editor.registerCommand(PASTE_COMMAND, event => {
					if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
					let add = latest.current.onFiles;
					let files = add ? [...event.clipboardData.files] : [];
					if (files.length === 0) return false;
					add!(files);
					let text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
					// A file copied from a folder brings its own name as text, which is not meant for the draft.
					let names = new Set(files.map(file => file.name));
					let named = text.split("\n").filter(Boolean).every(line => names.has(line.trim()));
					if (text && !named) {
						editor.update(() => $getSelection()?.insertRawText(text));
					}
					event.preventDefault();
					return true;
				}, COMMAND_PRIORITY_HIGH),
			);
			return () => {
				unregister();
				editor.setRootElement(null);
			};
		}, [editor]);

		useLayoutEffect(() => {
			editor.setEditable(!readOnly);
		}, [editor, readOnly]);

		// A login the draft now knows, or no longer does, is marked or unmarked where it is written.
		useLayoutEffect(() => {
			editor.update(() => {
				for (let node of $getRoot().getAllTextNodes()) {
					if (node.isSimpleText() || $isMentionNode(node)) node.markDirty();
				}
			}, { discrete: true, tag: [HISTORIC_TAG, ...away()] });
		}, [editor, mentionsKey]);

		useLayoutEffect(() => {
			let reset = historyKey.current !== resetKey;
			historyKey.current = resetKey;
			if (value !== known.current.value || !sameReferences(references, known.current.references)) {
				let focused = document.activeElement === root.current;
				let prior = index.current;
				let caret = selection.current;
				known.current = { value, references };
				editor.update(() => {
					if (!reset && $applyEdit(prior, value, references)) return;
					$writeBlocks(parseDraft(value, references));
					if (focused) {
						let fresh = $index();
						let at = Math.min(caret.start, value.length);
						$selectOffsets(at, Math.min(caret.end, value.length), fresh);
					} else $setSelection(null);
				}, {
					discrete: true,
					tag: [EXTERNAL_TAG, ...(reset ? [HISTORIC_TAG] : []), ...away()],
				});
				let markdown = index.current.serialized.markdown;
				told.current = markdown === value ? undefined : { value, markdown };
			}
			if (reset) editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
		}, [editor, value, references, resetKey]);

		// The words being said are drawn where they will go, outside the draft and its history.
		useLayoutEffect(() => {
			editor.update(() => {
				for (let node of $getRoot().getChildren()) {
					for (let found of $isElementNode(node) ? $interims(node) : []) found.remove();
				}
				if (!interim?.text) return;
				let ghost = new InterimNode(interim.text);
				let point = $offsetPoint(interim.at, $index());
				let node = $getNodeByKey(point.key);
				if (point.type === "text" && $isTextNode(node)) {
					if (point.offset === 0) node.insertBefore(ghost);
					else if (point.offset >= node.getTextContentSize()) node.insertAfter(ghost);
					else node.splitText(point.offset)[0]!.insertAfter(ghost);
				} else if ($isElementNode(node)) node.splice(point.offset, 0, [ghost]);
			}, { discrete: true, tag: [HISTORIC_TAG, INTERIM_TAG, ...away()] });
			mark(index.current.serialized.markdown);
		}, [editor, interim?.at, interim?.text]);

		let translate = (offset: number) => {
			let made = told.current;
			if (!made || made.markdown !== index.current.serialized.markdown) return offset;
			let change = contiguousReplacement(made.value, made.markdown);
			if (offset <= change.start) return offset;
			if (offset >= change.previousEnd) return offset + change.nextEnd - change.previousEnd;
			return change.nextEnd;
		};

		let linkable = () =>
			editor.getEditorState().read(() => {
				let current = $getSelection();
				return $isRangeSelection(current)
					&& (!current.isCollapsed()
						|| !!$findMatchingParent(current.anchor.getNode(), $isLinkNode));
			});

		let applyFormat = (kind: Exclude<Format, "link">) => {
			editor.update(() => {
				let current = $getSelection();
				if (!$isRangeSelection(current)) return;
				let node = current.anchor.getNode();
				let inCode = !!$findMatchingParent(node, $isCodeBlockNode);
				if (kind === "block") $toggleCodeBlock();
				else if (inCode) return;
				else if (kind === "numbered" || kind === "bulleted") {
					let type: ListType = kind === "numbered" ? "number" : "bullet";
					$toggleList(type);
				} else current.formatText(TEXT_FORMATS[kind]);
			}, { tag: HISTORY_PUSH_TAG });
		};

		useImperativeHandle(ref, () => ({
			focus: () => {
				root.current?.focus();
				editor.update(() => {
					if (!$getSelection()) $getRoot().selectEnd();
				}, { discrete: true });
			},
			setSelectionRange: (start, end) => {
				editor.update(
					() => $selectOffsets(translate(start), translate(end), $index()),
					{ discrete: true },
				);
			},
			get selectionStart() {
				return editor.getEditorState().read(() => $selectionOffsets($index()).start);
			},
			get selectionEnd() {
				return editor.getEditorState().read(() => $selectionOffsets($index()).end);
			},
			format: applyFormat,
			linkAddress: () =>
				editor.getEditorState().read(() => {
					let current = $getSelection();
					if (!$isRangeSelection(current)) return undefined;
					let link = $findMatchingParent(current.anchor.getNode(), $isLinkNode);
					return $isLinkNode(link) ? link.getURL() : undefined;
				}),
			holdSelection: () => {
				held.current = editor.getEditorState().read(() => $getSelection()?.clone() ?? null);
			},
			setLink: url => {
				editor.update(() => {
					let kept = held.current;
					held.current = null;
					if (kept) $setSelection(kept);
					let current = $getSelection();
					if (url === undefined || !$isRangeSelection(current)) return;
					let inLink = !!$findMatchingParent(current.anchor.getNode(), $isLinkNode);
					if (url && current.isCollapsed() && !inLink) {
						// With no words chosen, the address is the words.
						let words = $createTextNode(url);
						$insertNodes([$createLinkNode(url).append(words)]);
						words.select(url.length, url.length);
					} else $toggleLink(url);
				}, { discrete: true, tag: HISTORY_PUSH_TAG });
				root.current?.focus();
			},
		}), [editor]);

		let tellSelection = () => document.dispatchEvent(new Event("selectionchange"));

		let keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
			if (event.nativeEvent.isComposing || event.keyCode === 229) {
				// An input method's Enter chooses its words; it never sends.
				if (event.key === "Enter") event.stopPropagation();
				return;
			}
			latest.current.onKeyDown?.(event);
			if (event.isDefaultPrevented()) {
				// Chat took the key (a menu's choice, a send, the chip), so the editor never sees it.
				event.stopPropagation();
				return;
			}
			if (readOnly) return;
			// Lexical reads its selection when the page says it moved, which comes a moment after the
			// move; a key that edits the selection straight after one (as a select-all and Delete
			// do) is told first.
			if (["Backspace", "Delete"].includes(event.key) || event.metaKey || event.ctrlKey) {
				tellSelection();
			}
			let shortcut = formatShortcut(event);
			// As in the document, ⌘K is a link only for chosen words or a link already there, and is
			// search otherwise.
			if (shortcut === "link" && !linkable()) shortcut = undefined;
			if (shortcut) {
				event.preventDefault();
				event.stopPropagation();
				if (shortcut === "link") latest.current.onLink?.();
				else if (shortcut !== "underline") applyFormat(shortcut);
				return;
			}
			if (
				event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
			) {
				event.preventDefault();
				event.stopPropagation();
				breaking.current = true;
				try {
					editor.update(() => $breakLine(editor), { discrete: true });
				} finally {
					breaking.current = false;
				}
			}
		};

		return (
			<div
				role={role}
				aria-label={label}
				aria-disabled={disabled}
				aria-invalid={invalid}
				aria-describedby={describedBy}
				aria-autocomplete={autocomplete}
				aria-expanded={expanded}
				aria-controls={controls}
				aria-activedescendant={activeDescendant}
				aria-readonly={readOnly}
				aria-multiline="true"
				ref={root}
				className="composer-draft-input"
				contentEditable={!readOnly}
				suppressContentEditableWarning
				data-chat-rich=""
				data-placeholder={placeholder}
				spellCheck
				tabIndex={0}
				onKeyDownCapture={keyDown}
				// The page says the selection moved a moment after it did; a paste, and what reads the
				// caret once a key or the pointer is let go (dictation's place, a menu's query), are
				// told now.
				onPasteCapture={tellSelection}
				onKeyUp={tellSelection}
				onMouseUp={tellSelection}
				onFocus={() => {
					let offsets = editor.getEditorState().read(() => $selectionOffsets(index.current));
					latest.current.onSelect({
						currentTarget: {
							value: index.current.serialized.markdown,
							selectionStart: offsets.start,
							selectionEnd: offsets.end,
						},
					});
				}}
				onBlur={event => latest.current.onBlur?.(event)}
			/>
		);
	},
);

function $interims(element: ElementNode): LexicalNode[] {
	let found: LexicalNode[] = [];
	for (let child of element.getChildren()) {
		if ($isInterimNode(child)) found.push(child);
		else if ($isElementNode(child)) found.push(...$interims(child));
	}
	return found;
}

/**
 * Applies `Chat`'s change of the draft as the edit it is, where it falls inside one block's words:
 * the words it replaced go, and its words and chips are put in their place in the marks round them.
 * Says whether it could; where it could not, the draft is read again whole.
 */
function $applyEdit(
	prior: SlotIndex,
	value: string,
	references: readonly ReferenceDraft[],
): boolean {
	let old = prior.serialized;
	let change = contiguousReplacement(old.markdown, value);
	let inserted = value.slice(change.start, change.nextEnd);
	let removed = old.markdown.slice(change.start, change.previousEnd);
	if (inserted.includes("\n") || removed.includes("\n") || !old.markdown) return false;
	let shift = change.nextEnd - change.previousEnd;
	let kept = old.references.flatMap(reference =>
		reference.end <= change.start
			? [reference]
			: reference.start >= change.previousEnd
			? [{ ...reference, start: reference.start + shift, end: reference.end + shift }]
			: []
	);
	let same = (left: ReferenceDraft, right: ReferenceDraft) =>
		left.start === right.start && left.end === right.end
		&& referenceTargetKey(left) === referenceTargetKey(right);
	if (!kept.every(reference => references.some(other => same(reference, other)))) return false;
	let added = references.filter(reference => !kept.some(other => same(reference, other)));
	if (added.some(reference => reference.start < change.start || reference.end > change.nextEnd)) {
		return false;
	}
	// Only words are replaced: none of the marks of a format.
	let covered = 0;
	for (let slot of old.slots) {
		if (slot.kind !== "leaf") continue;
		for (let segment of slot.segments) {
			covered += Math.max(
				0,
				Math.min(segment.md + segment.length, change.previousEnd)
					- Math.max(segment.md, change.start),
			);
		}
	}
	if (covered !== removed.length) return false;
	let start = $offsetPoint(change.start, prior);
	let end = $offsetPoint(change.previousEnd, prior);
	if (
		$pointOffset(start, prior) !== change.start || $pointOffset(end, prior) !== change.previousEnd
	) return false;
	let startNode = $getNodeByKey(start.key);
	let endNode = $getNodeByKey(end.key);
	if (!startNode || !endNode) return false;
	let block = $topBlock(startNode);
	if (block !== $topBlock(endNode) || $isCodeBlockNode(block)) return false;
	let selection = $selectOffsets(change.start, change.previousEnd, prior);
	if (!selection.isCollapsed()) selection.removeText();
	let at = change.start;
	for (let reference of [...added].sort((left, right) => left.start - right.start)) {
		let words = value.slice(at, reference.start);
		if (words) $getSelection()?.insertText(words);
		let { start: _start, end: _end, ...payload } = reference;
		$getSelection()?.insertNodes([
			$createChipNode(value.slice(reference.start, reference.end), payload as ReferencePayload),
		]);
		at = reference.end;
	}
	let rest = value.slice(at, change.nextEnd);
	if (rest) $getSelection()?.insertText(rest);
	return true;
}
