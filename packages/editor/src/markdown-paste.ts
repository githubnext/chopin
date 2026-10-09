/**
 * Markdown copied as plain text becomes structure when pasted.
 *
 * Chat, GitHub and terminals hand over `## Heading` and `**bold**` as plain
 * text, and Lexical's own paste writes that literally. A paste that reads as
 * Markdown is parsed by the dialect instead and inserted as the blocks it
 * describes.
 *
 * The parse turns components off, so `<Questionnaire>` or any other tag stays
 * literal text and a paste can never mint a protected projection. The result
 * must also validate; anything the dialect would refuse falls back to the
 * ordinary literal paste rather than being half-converted.
 *
 * The server also judges what a batch introduces (hidden characters in URLs,
 * `//host` links) and the whole document (image count, nesting). A paste the
 * room would refuse would rebuild it for everyone, so those checks run here
 * first, against the document as it stands.
 *
 * Only clear syntax counts. A lone `*` or a sentence starting `#1` is prose,
 * and so is everything pasted inside code, a table cell or with ⇧⌘V. The Edit
 * menu's "Paste and Match Style" fires no keystroke and browsers report it as
 * an ordinary paste, so it still converts.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isTableCellNode } from "@lexical/table";
import {
	$addUpdateTag,
	$getRoot,
	$getSelection,
	$isDecoratorNode,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_HIGH,
	KEY_DOWN_COMMAND,
	mergeRegister,
	PASTE_COMMAND,
	PASTE_TAG,
} from "lexical";
import {
	$createPlanNodes,
	$isCodeBlockNode,
	$isImageNode,
	$isMathNode,
	assertIntroducedUrls,
	limits,
	parse,
	registry as buildRegistry,
	validate,
} from "@chopin/dialect";

import type { LexicalEditor, LexicalNode, RangeSelection } from "lexical";
import type { Registry } from "@chopin/dialect";

type Root = ReturnType<typeof parse>;
type Tree = { type: string; children?: Tree[] };

/*
 * Lexical inserts inline runs in quadratic time, and the Markdown parser is
 * quadratic on long runs of lone `*` or `_`, so thousands of either would
 * freeze the tab. A paste that big or that fragmented is not prose anyone
 * wrote by hand; it pastes literally.
 */
const MAX_PASTE_CHARACTERS = 64 * 1024;
const MAX_PASTE_EMPHASIS = 4_000;
const MAX_PASTE_NODES = 20_000;
const MAX_PASTE_CHILDREN = 200;

/** What the paste lands in: images already present and the nesting at the caret. */
export type Destination = { images: number; depth: number };

const HEADING = /^ {0,3}#{1,6}[ \t]+\S/;
const QUOTE = /^ {0,3}>[ \t]*\S/;
const TASK = /^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+\S/;
const BULLET = /^[ \t]*[-*+][ \t]+\S/;
const ORDERED = /^[ \t]*(\d{1,9})[.)][ \t]+\S/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;

// Each excludes its own delimiter from the run between, so a scan never
// revisits text: a long line of `**` or `[x](` stays linear.
const STRONG = /\*\*(?=[^\s*])[^*\n]*[^\s*]\*\*/;
const STRIKE = /~~(?=[^\s~])[^~\n]*[^\s~]~~/;
const LINK = /\[[^[\]\n]{1,500}\]\([^()\s]{1,2048}(?:[ \t]+"[^"\n]{0,500}")?\)/;
const CODE = /`[^`\n]+`/;

/** Tags a rich source uses for structure. Code editors send only `div`, `span` and `br`. */
const SEMANTIC_HTML = /<(?:h[1-6]|p|ul|ol|li|table|blockquote|pre|code|strong|b|em|i|a|img)[\s>/]/i;

function closes(line: string, open: string): boolean {
	let trimmed = line.trim();
	return trimmed[0] === open[0] && trimmed.length >= open.length && /^(`+|~+)$/.test(trimmed);
}

/** True when plain text carries unambiguous Markdown syntax. */
export function looksLikeMarkdown(text: string): boolean {
	if (text.length > MAX_PASTE_CHARACTERS) return false;
	let items = 0;
	let ordered = false;
	let open: string | undefined;
	let previous = "";
	for (let line of text.split("\n")) {
		if (open) {
			if (closes(line, open)) return true;
			continue;
		}
		let fence = FENCE.exec(line);
		if (fence) {
			open = fence[1];
			continue;
		}
		if (HEADING.test(line) || QUOTE.test(line) || TASK.test(line)) return true;
		if (previous.includes("|") && TABLE_DELIMITER.test(line)) return true;
		let number = ORDERED.exec(line)?.[1];
		if (BULLET.test(line)) items++;
		// `1986. A great year.` is a sentence until a list starts at one.
		else if (number !== undefined && (ordered || Number(number) === 1)) {
			items++;
			ordered = true;
		} else if (line.trim()) ordered = false;
		previous = line;
	}
	// One `- ` line is as likely a dash in prose as a list.
	if (items >= 2) return true;
	return STRONG.test(text) || STRIKE.test(text) || LINK.test(text) || CODE.test(text);
}

/**
 * End a list at the first unindented line that is not an item.
 *
 * Markdown folds `Thanks` after `- hotel` into that item as a lazy
 * continuation, which is never what an email or a chat message meant.
 */
export function separateLists(text: string): string {
	let out: string[] = [];
	let list = false;
	let open: string | undefined;
	for (let line of text.split("\n")) {
		if (open) {
			if (closes(line, open)) open = undefined;
			out.push(line);
			continue;
		}
		let fence = FENCE.exec(line);
		if (fence) open = fence[1];
		if (BULLET.test(line) || ORDERED.test(line)) list = true;
		else if (list && line.trim() && !/^[ \t]/.test(line)) {
			out.push("");
			list = false;
		}
		out.push(line);
	}
	return out.join("\n");
}

/** Depth as `validate` counts it, with the root at zero. */
function depth(node: Tree): number {
	let deepest = 0;
	for (let child of node.children ?? []) deepest = Math.max(deepest, depth(child) + 1);
	return deepest;
}

/** Node count, or Infinity once any one block holds too many children. */
function size(node: Tree): number {
	let children = node.children ?? [];
	if (node.type !== "root" && children.length > MAX_PASTE_CHILDREN) return Infinity;
	let count = 1;
	for (let child of children) count += size(child);
	return count;
}

function images(node: Tree): number {
	let count = node.type === "image" ? 1 : 0;
	for (let child of node.children ?? []) count += images(child);
	return count;
}

/**
 * The document cannot hold a list's starting number: export writes every
 * ordered list from one. Rather than renumber `5. 6.` into `1. 2.`, such a
 * list stays as numbered lines of text.
 *
 * @returns false when a list cannot be kept as lines.
 */
function keepNumbers(node: Tree): boolean {
	let children = node.children;
	if (!children) return true;
	for (let index = 0; index < children.length; index++) {
		let child = children[index] as Tree & { ordered?: boolean; start?: number | null };
		if (child.type === "list" && child.ordered && (child.start ?? 1) !== 1) {
			let lines: Tree[] = [];
			for (let [offset, item] of (child.children ?? []).entries()) {
				let [paragraph, ...rest] = item.children ?? [];
				let checked = (item as { checked?: boolean | null }).checked;
				if (paragraph?.type !== "paragraph" || rest.length > 0 || checked != null) return false;
				let prefix = { type: "text", value: `${child.start! + offset}. ` } as Tree;
				lines.push({ type: "paragraph", children: [prefix, ...(paragraph.children ?? [])] });
			}
			children.splice(index, 1, ...lines);
			index += lines.length - 1;
		} else if (!keepNumbers(child)) return false;
	}
	return true;
}

/**
 * Whether the clipboard should be read as Markdown at all.
 *
 * Lexical's own format and semantic HTML already convert. HTML with no
 * structure in it, as a code editor copies, carries nothing the text does not.
 */
export function prefersMarkdown(types: readonly string[], html: string): boolean {
	if (!types.includes("text/plain")) return false;
	if (types.includes("application/x-lexical-editor") || types.includes("Files")) return false;
	return !types.includes("text/html") || !SEMANTIC_HTML.test(html);
}

/** ⇧⌘V, ⌥⇧⌘V and Ctrl+Shift+V, on any keyboard layout. */
export function isPlainPasteKey(
	event: Pick<KeyboardEvent, "shiftKey" | "metaKey" | "ctrlKey" | "key" | "code">,
): boolean {
	return event.shiftKey && (event.metaKey || event.ctrlKey)
		&& (event.code === "KeyV" || event.key.toLowerCase() === "v");
}

/**
 * The dialect tree for pasted text, or undefined when it should paste literally.
 *
 * `into` describes the document the paste lands in, so limits the server
 * checks across the whole document are checked here too.
 */
export function pastedMarkdown(
	text: string,
	into: Destination = { images: 0, depth: 0 },
): Root | undefined {
	if (!looksLikeMarkdown(text)) return undefined;
	let emphasis = 0;
	for (let index = 0; index < text.length; index++) {
		let code = text.charCodeAt(index);
		if ((code === 42 || code === 95) && ++emphasis > MAX_PASTE_EMPHASIS) return undefined;
	}
	let bytes = new TextEncoder().encode(text).byteLength;
	if (bytes > limits.MAX_SOURCE_BYTES) return undefined;
	let tree: Root;
	try {
		tree = parse(separateLists(text), { jsx: false, singleDollarMath: false });
		if (size(tree as Tree) > MAX_PASTE_NODES) return undefined;
		if (!keepNumbers(tree as Tree)) return undefined;
		assertIntroducedUrls([], tree.children);
	} catch {
		return undefined;
	}
	if (tree.children.length === 0 || !validate(tree, { bytes }).ok) return undefined;
	if (into.images + images(tree as Tree) > limits.MAX_IMAGES) return undefined;
	if (into.depth + depth(tree as Tree) > limits.MAX_DEPTH) return undefined;
	return tree;
}

function $countImages(node: LexicalNode): number {
	if ($isImageNode(node)) return 1;
	if (!$isElementNode(node)) return 0;
	let count = 0;
	for (let child of node.getChildren()) count += $countImages(child);
	return count;
}

/**
 * Where pasted blocks will sit. Counted from the caret's own node, which
 * errs deep: a Lexical list item is an item and a paragraph in Markdown.
 */
function $destination(node: LexicalNode): Destination {
	let depth = 1;
	for (let parent = node.getParent(); parent && parent.getParent(); parent = parent.getParent()) {
		depth++;
	}
	return { images: $countImages($getRoot()), depth };
}

/** Somewhere a paste is text whatever it looks like. */
function literalHere(node: LexicalNode): boolean {
	if ($isTextNode(node) && node.hasFormat("code")) return true;
	let cursor: LexicalNode | null = node;
	while (cursor) {
		if ($isCodeBlockNode(cursor) || $isMathNode(cursor) || $isTableCellNode(cursor)) return true;
		cursor = cursor.getParent();
	}
	return false;
}

let shared: Registry | undefined;

/**
 * Insert pasted Markdown at the selection. Call inside an update.
 *
 * @returns false when the text should paste literally instead.
 */
export function $pasteMarkdown(selection: RangeSelection, text: string): boolean {
	if (literalHere(selection.anchor.getNode()) || literalHere(selection.focus.getNode())) {
		return false;
	}
	// Replacing a card is the deletion guards' call, not a paste's.
	if (!selection.isCollapsed() && selection.getNodes().some($isDecoratorNode)) return false;
	let tree = pastedMarkdown(text, $destination(selection.anchor.getNode()));
	if (!tree) return false;
	shared ??= buildRegistry();
	selection.insertNodes($createPlanNodes(tree, { registry: shared, validate: false }));
	return true;
}

export function registerMarkdownPaste(editor: LexicalEditor): () => void {
	// ⇧⌘V reaches the paste handler looking like any plain-text paste.
	let plain = false;
	return mergeRegister(
		editor.registerCommand(
			KEY_DOWN_COMMAND,
			event => {
				plain = isPlainPasteKey(event);
				return false;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		editor.registerCommand(
			PASTE_COMMAND,
			event => {
				let literal = plain;
				plain = false;
				if (literal || !(event instanceof ClipboardEvent)) return false;
				let data = event.clipboardData;
				if (!data || !prefersMarkdown([...data.types], data.getData("text/html"))) return false;
				let text = data.getData("text/plain");
				let selection = $getSelection();
				// Commands already run inside an update.
				if (!$isRangeSelection(selection) || !$pasteMarkdown(selection, text)) return false;
				$addUpdateTag(PASTE_TAG);
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		),
	);
}

export function MarkdownPastePlugin() {
	let [editor] = useLexicalComposerContext();
	useEffect(() => registerMarkdownPaste(editor), [editor]);
	return null;
}
