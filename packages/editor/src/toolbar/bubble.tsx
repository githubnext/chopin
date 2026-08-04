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

/** How close to the window edge the bubble may sit. */
const EDGE = 8;

export function SelectionBubble(
	{ disabled, onComment }: { disabled?: boolean; onComment?: () => void },
) {
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

	/**
	 * Sit the bubble above the selection, and keep it on screen.
	 *
	 * This is the only thing that places the bubble. It used to share the job
	 * with Tailwind's translate utilities, which compile to the `translate`
	 * property rather than `transform` — a separate property that composes
	 * with it, so the bubble was offset by a full width and two full heights.
	 *
	 * Width comes from `offsetWidth` rather than a measured rect, because a
	 * rect already includes the transform being calculated: reading one here
	 * would make the edge correction depend on its own previous output, and
	 * near an edge it would alternate between two positions every time the
	 * block menu changed the bubble's width.
	 */
	useLayoutEffect(() => {
		let element = ref.current;
		if (!element || !position) return;

		let half = element.offsetWidth / 2;
		let overflow = position.left + half - (window.innerWidth - EDGE);
		// The plan is a middle column now and can be dragged narrow, so a
		// selection near its left edge needs the same treatment as its right.
		let underflow = EDGE - (position.left - half);
		let shift = overflow > 0 ? -overflow : underflow > 0 ? underflow : 0;

		element.style.transform = `translate(calc(-50% + ${shift}px), -100%)`;
	}, [position, choosing]);

	if (!position) return null;

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label="Text formatting"
			contentEditable={false}
			// No translate utilities here: placement belongs to the layout effect,
			// and Tailwind's would compose with its transform rather than replace it.
			className="fixed z-50 flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
			style={{ top: position.top - EDGE, left: position.left }}
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
						className={`size-7 rounded-sm text-xs font-semibold transition-colors ${
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
							className="size-7 rounded-sm text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
								className={`size-7 rounded-sm text-xs font-semibold transition-colors ${
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
							className="size-7 rounded-sm text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							🔗
						</button>

						{onComment && (
							<>
								<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
								<button
									type="button"
									aria-label="Comment on this passage"
									title="Comment on this passage"
									/*
									 * The passage is captured now, inside the click, because
									 * the composer this opens takes focus — and the selection
									 * goes with it. A draft that forgot what it was about the
									 * moment you started typing would be no use.
									 */
									onClick={onComment}
									className="size-7 rounded-sm text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								>
									💬
								</button>
							</>
						)}
					</>
				)}
		</div>
	);
}
