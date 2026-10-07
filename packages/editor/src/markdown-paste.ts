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
 * Only clear syntax counts. A lone `*` or a sentence starting `#1` is prose,
 * and so is everything pasted inside code, a table cell or with ⇧⌘V.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isTableCellNode } from "@lexical/table";
import {
	$addUpdateTag,
	$getSelection,
	$isDecoratorNode,
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
	$isMathNode,
	parse,
	registry as buildRegistry,
	validate,
} from "@chopin/dialect";

import type { LexicalEditor, LexicalNode, RangeSelection } from "lexical";
import type { Registry } from "@chopin/dialect";

type Root = ReturnType<typeof parse>;

const HEADING = /^ {0,3}#{1,6}[ \t]+\S/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n(?:[^\n]*\n)*? {0,3}\1/m;
const QUOTE = /^ {0,3}>[ \t]*\S/m;
const TASK = /^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+\S/m;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/gm;
const TABLE = /^.*\|.*\n {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m;

const STRONG = /(\*\*|__)(?=\S)[^\n]*?\S\1/;
const STRIKE = /~~(?=\S)[^\n]*?\S~~/;
const LINK = /\[[^\]\n]+\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/;
const CODE = /`[^`\n]+`/;

/** Tags a rich source uses for structure. Code editors send only `div`, `span` and `br`. */
const SEMANTIC_HTML = /<(?:h[1-6]|p|ul|ol|li|table|blockquote|pre|code|strong|b|em|i|a|img)[\s>/]/i;

/** True when plain text carries unambiguous Markdown syntax. */
export function looksLikeMarkdown(text: string): boolean {
	if (HEADING.test(text) || FENCE.test(text) || QUOTE.test(text) || TASK.test(text)) return true;
	if (TABLE.test(text)) return true;
	// One `- ` line is as likely a dash in prose as a list.
	if ((text.match(LIST_ITEM)?.length ?? 0) >= 2) return true;
	return STRONG.test(text) || STRIKE.test(text) || LINK.test(text) || CODE.test(text);
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

/** The dialect tree for pasted text, or undefined when it should paste literally. */
export function pastedMarkdown(text: string): Root | undefined {
	if (!looksLikeMarkdown(text)) return undefined;
	let tree: Root;
	try {
		tree = parse(text, { jsx: false, singleDollarMath: false });
	} catch {
		return undefined;
	}
	if (tree.children.length === 0 || !validate(tree).ok) return undefined;
	return tree;
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
	let tree = pastedMarkdown(text);
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
				plain = event.shiftKey && (event.metaKey || event.ctrlKey)
					&& event.key.toLowerCase() === "v";
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
