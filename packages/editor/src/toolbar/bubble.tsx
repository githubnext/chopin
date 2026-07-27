/**
 * Inline formatting, shown over the selection.
 *
 * Marks are text formats rather than nodes, so applying one is local and
 * immediate — no identifier to obtain, nothing for the server to arbitrate.
 * That is what lets this stay a plain toolbar rather than a request.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { TOGGLE_LINK_COMMAND } from "@lexical/link";
import { LINK_PROTOCOLS } from "@chopin/dialect";

import { askForUrl } from "./url";
import {
	$isListItemNode,
	$isListNode,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
	REMOVE_LIST_COMMAND,
} from "@lexical/list";
import {
	$createHeadingNode,
	$createQuoteNode,
	$isHeadingNode,
	$isQuoteNode,
} from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
	$createParagraphNode,
	$getSelection,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
	FORMAT_TEXT_COMMAND,
	KEY_DOWN_COMMAND,
	SELECTION_CHANGE_COMMAND,
} from "lexical";

import type { HeadingTagType } from "@lexical/rich-text";
import type { ElementNode, LexicalNode, TextFormatType } from "lexical";

/** Block shapes the bubble can switch between. */
export type Block = "paragraph" | "quote" | "bullet" | "number" | HeadingTagType;

/** `glyph` is what shows; `label` is what it means, for hover and assistive tech. */
const BLOCKS: Array<{ id: Block; glyph: string; label: string }> = [
	{ id: "paragraph", glyph: "T", label: "Text" },
	{ id: "h1", glyph: "H1", label: "Heading 1" },
	{ id: "h2", glyph: "H2", label: "Heading 2" },
	{ id: "h3", glyph: "H3", label: "Heading 3" },
	{ id: "quote", glyph: ">", label: "Blockquote" },
	{ id: "bullet", glyph: "UL", label: "Bulleted list" },
	{ id: "number", glyph: "OL", label: "Numbered list" },
];

/**
 * How to show a block the menu does not offer.
 *
 * Headings run to six and only three are worth a button, but a plan written by
 * an agent may hold any of them, and the trigger has to say so rather than
 * claim the selection is something it is not.
 */
function describe(block: Block): { glyph: string; label: string } {
	let known = BLOCKS.find(item => item.id === block);
	if (known) return known;
	return { glyph: block.toUpperCase(), label: `Heading ${block.slice(1)}` };
}

/**
 * The block a change of type would act on.
 *
 * The nearest element that is not inline, which is the same block
 * `$setBlocksType` collects. Deliberately not the top-level one: a paragraph
 * inside a callout is its own block, and resolving to the callout would report
 * a type nothing here can apply.
 */
function owner(node: LexicalNode | null): ElementNode | undefined {
	let cursor = node;
	while (cursor) {
		if ($isElementNode(cursor) && !cursor.isInline()) return cursor;
		cursor = cursor.getParent();
	}
	return undefined;
}

/**
 * The quote wrapped around this block, if it is the block's whole reason for
 * being a quote.
 *
 * Quotes arrive in two shapes. Imported markdown gives `quote > paragraph`,
 * while `$setBlocksType` moves the old block's children straight in and gives
 * `quote > text`. Both write out as `> …`, so neither is wrong, but anything
 * acting on a quote has to recognise the pair.
 */
function quoted(block: ElementNode | undefined): ElementNode | undefined {
	if (!block) return undefined;
	if ($isQuoteNode(block)) return block;
	let parent = block.getParent();
	return $isParagraphNode(block) && $isQuoteNode(parent) ? parent : undefined;
}

/** What the selection is sitting in. Call inside a read. */
export function $block(node: LexicalNode | null): Block {
	let block = owner(node);
	if (!block) return "paragraph";

	// A list item's shape belongs to the list around it, not the item.
	if ($isListItemNode(block)) {
		let list = block.getParent();
		if ($isListNode(list)) return list.getListType() === "number" ? "number" : "bullet";
	}
	if ($isHeadingNode(block)) return block.getTag();
	if (quoted(block)) return "quote";
	return "paragraph";
}

type Mark = { format: TextFormatType; label: string; glyph: string; shortcut: string };

const MARKS: Mark[] = [
	{ format: "bold", label: "Bold", glyph: "B", shortcut: "⌘B" },
	{ format: "italic", label: "Italic", glyph: "I", shortcut: "⌘I" },
	{ format: "strikethrough", label: "Strikethrough", glyph: "S", shortcut: "⌘⇧X" },
	{ format: "underline", label: "Underline", glyph: "U", shortcut: "⌘U" },
	{ format: "code", label: "Inline code", glyph: "<>", shortcut: "⌘E" },
];

type Position = { top: number; left: number };

export function SelectionBubble({ disabled }: { disabled?: boolean }) {
	let [editor] = useLexicalComposerContext();
	let [position, setPosition] = useState<Position>();
	let [active, setActive] = useState<Set<TextFormatType>>(new Set());
	let [block, setBlock] = useState<Block>("paragraph");
	/** Whether the bubble is showing block types instead of its marks. */
	let [choosing, setChoosing] = useState(false);
	let ref = useRef<HTMLDivElement>(null);

	let sync = useCallback(() => {
		editor.getEditorState().read(() => {
			let selection = $getSelection();

			if (!$isRangeSelection(selection) || selection.isCollapsed() || disabled) {
				setPosition(undefined);
				// Losing the selection dismisses the bubble, so the menu must
				// not be left open to reappear over the next one.
				setChoosing(false);
				return;
			}

			let marks = new Set<TextFormatType>();
			for (let mark of MARKS) {
				if (selection.hasFormat(mark.format)) marks.add(mark.format);
			}
			setActive(marks);
			setBlock($block(selection.anchor.getNode()));

			// Position against the live DOM selection: Lexical offsets do not
			// map to screen coordinates, and the caret may span nodes.
			let native = window.getSelection();
			if (!native || native.rangeCount === 0) return setPosition(undefined);

			let rect = native.getRangeAt(0).getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) return setPosition(undefined);

			setPosition({ top: rect.top, left: rect.left + rect.width / 2 });
		});
	}, [editor, disabled]);

	useEffect(() => {
		let stop = editor.registerCommand(
			SELECTION_CHANGE_COMMAND,
			() => {
				sync();
				return false;
			},
			COMMAND_PRIORITY_LOW,
		);
		let off = editor.registerUpdateListener(sync);
		return () => {
			stop();
			off();
		};
	}, [editor, sync]);

	let convert = useCallback((next: Block) => {
		setChoosing(false);
		// Already a quote: converting again would nest one inside the other.
		if (next === block) return;

		if (next === "bullet") {
			return editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
		}
		if (next === "number") {
			return editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
		}
		// Containers are unwrapped, not swapped: `$setBlocksType` converts the
		// block it finds and leaves the list or quote standing around it.
		if (block === "bullet" || block === "number") {
			editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
		}
		if (block === "quote") {
			editor.update(() => {
				let selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				let inner = owner(selection.anchor.getNode());
				// Only the wrapping shape needs lifting. Where the quote is
				// itself the block, `$setBlocksType` below replaces it.
				if ($isQuoteNode(inner)) return;
				let quote = quoted(inner);
				if (!quote) return;
				for (let child of quote.getChildren()) quote.insertBefore(child);
				quote.remove();
			});
		}

		let build: () => ElementNode = next === "quote"
			? $createQuoteNode
			: next === "paragraph"
			? $createParagraphNode
			: () => $createHeadingNode(next);

		editor.update(() => {
			let selection = $getSelection();
			if ($isRangeSelection(selection)) $setBlocksType(selection, build);
		});
	}, [editor, block]);

	/*
	 * Dismiss the menu with Escape.
	 *
	 * Registered on the editor, not the bubble: nothing in the bubble can take
	 * focus — that is the whole point of cancelling mousedown — so a handler
	 * there would never see a key.
	 */
	useEffect(() => {
		if (!choosing) return;
		return editor.registerCommand(
			KEY_DOWN_COMMAND,
			(event: KeyboardEvent) => {
				if (event.key !== "Escape") return false;
				event.preventDefault();
				setChoosing(false);
				return true;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor, choosing]);

	// Keep the bubble on screen when the selection sits near an edge. Opening
	// the menu changes its width, so that has to be measured again too.
	useLayoutEffect(() => {
		let element = ref.current;
		if (!element || !position) return;
		let rect = element.getBoundingClientRect();
		let overflow = rect.right - window.innerWidth + 8;
		if (overflow > 0) element.style.transform = `translate(calc(-50% - ${overflow}px), -100%)`;
		else element.style.transform = "translate(-50%, -100%)";
	}, [position, choosing]);

	if (!position) return null;

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label="Text formatting"
			contentEditable={false}
			className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
			style={{ top: position.top - 8, left: position.left }}
			/*
			 * Nothing in here may take focus: the selection it acts on would go
			 * with it. That rules out any control whose behaviour is a mousedown
			 * default — a native `select` never opens — so the block menu is
			 * buttons, and it borrows the bubble rather than opening beside it.
			 */
			onMouseDown={event => event.preventDefault()}
		>
			{choosing
				? BLOCKS.map(item => (
					<button
						key={item.id}
						type="button"
						aria-label={item.label}
						aria-current={item.id === block}
						title={item.label}
						onClick={() => convert(item.id)}
						className={`size-7 rounded text-xs font-semibold transition-colors ${
							item.id === block
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:bg-muted hover:text-foreground"
						}`}
					>
						{item.glyph}
					</button>
				))
				: (
					<>
						<button
							type="button"
							aria-label={`Block type: ${describe(block).label}`}
							aria-expanded={false}
							title={`${describe(block).label} — change block type`}
							onClick={() => setChoosing(true)}
							className="size-7 rounded text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							{describe(block).glyph}
						</button>

						<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />

						{MARKS.map(mark => (
							<button
								key={mark.format}
								type="button"
								aria-label={mark.label}
								aria-pressed={active.has(mark.format)}
								title={`${mark.label} (${mark.shortcut})`}
								onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, mark.format)}
								className={`size-7 rounded text-xs font-semibold transition-colors ${
									active.has(mark.format)
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:bg-muted hover:text-foreground"
								}`}
							>
								{mark.glyph}
							</button>
						))}

						<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />

						<button
							type="button"
							aria-label="Add link"
							title="Add link (⌘K)"
							onClick={() => {
								// `undefined` means cancelled or refused; `null` means cleared.
								let url = askForUrl("Link URL", { protocols: LINK_PROTOCOLS, relative: true });
								if (url === undefined) return;
								editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
							}}
							className="size-7 rounded text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							🔗
						</button>
					</>
				)}
		</div>
	);
}
