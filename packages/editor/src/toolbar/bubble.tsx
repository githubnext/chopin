/**
 * Inline formatting, shown over the selection.
 *
 * Marks are text formats rather than nodes, so applying one is local and
 * immediate — no identifier to obtain, nothing for the server to arbitrate.
 * That is what lets this stay a plain toolbar rather than a request.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ChevronIcon, CodeIcon, LinkPlusIcon, MessagePlusIcon } from "@chopin/icons";

import { $linkAt, OPEN_LINK_EDITOR_COMMAND } from "./link";
import { placeSurface, visibleAnchor } from "./placement";
import { shortcut } from "./shortcut";
import { PRIMARY_COARSE_POINTER_QUERY } from "../pointer";
import {
	CELL,
	CELL_OFF,
	CELL_ON,
	DIVIDER,
	editorSurfaceViewport,
	listenToEditorGeometry,
	nativeSelectionRect,
	ROW,
	SEAM,
	SHELL,
} from "./surface";
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
	COMMAND_PRIORITY_HIGH,
	COMMAND_PRIORITY_LOW,
	FORMAT_TEXT_COMMAND,
	KEY_ESCAPE_COMMAND,
	SELECTION_CHANGE_COMMAND,
} from "lexical";

import type { HeadingTagType } from "@lexical/rich-text";
import type { ElementNode, LexicalNode, TextFormatType } from "lexical";
import type { DOMRectLike, SurfacePlacement } from "./placement";

/** Block shapes the bubble can switch between. */
/** `task` is shown but not offered: the menu has no way to build a check list. */
export type Block = "paragraph" | "quote" | "bullet" | "number" | "task" | HeadingTagType;

/** `glyph` is what shows; `label` is what it means, for hover and assistive tech. */
const BLOCKS: Array<{ id: Block; glyph: string; label: string }> = [
	{ id: "paragraph", glyph: "T", label: "Text" },
	{ id: "h1", glyph: "H1", label: "Heading 1" },
	{ id: "h2", glyph: "H2", label: "Heading 2" },
	{ id: "h3", glyph: "H3", label: "Heading 3" },
	{ id: "quote", glyph: ">", label: "Quote" },
	{ id: "bullet", glyph: "UL", label: "Bulleted list" },
	{ id: "number", glyph: "OL", label: "Numbered list" },
];

const SHORT: Partial<Record<Block, string>> = {
	paragraph: "Text",
	quote: "Quote",
	bullet: "List",
	number: "Numbered",
};

/**
 * How to show a block the menu does not offer.
 *
 * Headings run to six and only three are worth a button, but a plan written by
 * an agent may hold any of them, and the trigger has to say so rather than
 * claim the selection is something it is not.
 */
function describe(block: Block): { short: string; label: string } {
	if (block === "task") return { short: "Task list", label: "Task list" };
	let known = BLOCKS.find(item => item.id === block);
	if (known) return { short: SHORT[block] ?? known.glyph, label: known.label };
	return { short: block.toUpperCase(), label: `Heading ${block.slice(1)}` };
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
		if ($isListNode(list)) {
			let type = list.getListType();
			return type === "number" ? "number" : type === "check" ? "task" : "bullet";
		}
	}
	if ($isHeadingNode(block)) return block.getTag();
	if (quoted(block)) return "quote";
	return "paragraph";
}

type Mark = { format: TextFormatType; label: string; glyph: ReactNode; shortcut: string };

/** Each letter is drawn in the style it applies, so the row reads as a format bar. */
const MARKS: Mark[] = [
	{
		format: "bold",
		label: "Bold",
		glyph: <span className="font-bold">B</span>,
		shortcut: shortcut("B"),
	},
	{
		format: "italic",
		label: "Italic",
		glyph: <span className="italic">I</span>,
		shortcut: shortcut("I"),
	},
	{
		format: "strikethrough",
		label: "Strikethrough",
		glyph: <span className="line-through">S</span>,
		shortcut: shortcut("X", { shift: true }),
	},
	{
		format: "underline",
		label: "Underline",
		glyph: <span className="underline underline-offset-2">U</span>,
		shortcut: shortcut("U"),
	},
	{ format: "code", label: "Inline code", glyph: <CodeIcon />, shortcut: shortcut("E") },
];

/** Marks a phone keeps on the row; the rest move into the block menu. */
const PHONE_ROW = new Set<TextFormatType>(["bold", "italic"]);

/** Roughly how far the system's end handle hangs below a touch selection. */
const SELECTION_HANDLE = 16;

function usePrimaryCoarse(): boolean {
	let [coarse, setCoarse] = useState(() => matchMedia(PRIMARY_COARSE_POINTER_QUERY).matches);
	useEffect(() => {
		let query = matchMedia(PRIMARY_COARSE_POINTER_QUERY);
		let update = () => setCoarse(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return coarse;
}

export function SelectionBubble(
	{ disabled, hidden, onComment }: {
		disabled?: boolean;
		/** Another surface has taken the bubble's place for now. */
		hidden?: boolean;
		onComment?: () => void;
	},
) {
	let [editor] = useLexicalComposerContext();
	let [anchor, setAnchor] = useState<DOMRectLike>();
	let [position, setPosition] = useState<SurfacePlacement>();
	let [active, setActive] = useState<Set<TextFormatType>>(new Set());
	let [block, setBlock] = useState<Block>("paragraph");
	let [linked, setLinked] = useState(false);
	/** Whether the bubble is showing block types instead of its marks. */
	let [choosing, setChoosing] = useState(false);
	let ref = useRef<HTMLDivElement>(null);
	let coarse = usePrimaryCoarse();

	let sync = useCallback(() => {
		editor.getEditorState().read(() => {
			let selection = $getSelection();

			if (!$isRangeSelection(selection) || selection.isCollapsed() || disabled) {
				setAnchor(undefined);
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
			setLinked(!!$linkAt(selection));

			// Position against the live DOM selection: Lexical offsets do not
			// map to screen coordinates, and the caret may span nodes.
			let rect = nativeSelectionRect();
			if (!rect) return setPosition(undefined);
			if (rect.width === 0 && rect.height === 0) return setPosition(undefined);

			setAnchor(rect);
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
		if (next === block || next === "task") return;

		if (next === "bullet") {
			return editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
		}
		if (next === "number") {
			return editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
		}
		// Containers are unwrapped, not swapped: `$setBlocksType` converts the
		// block it finds and leaves the list or quote standing around it.
		if (block === "bullet" || block === "number" || block === "task") {
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
	 * Escape closes the block menu, or else lets go of the selection: it
	 * collapses to where the caret was heading, and focus stays in the editor.
	 *
	 * Registered on the editor, not the bubble: nothing in the bubble can take
	 * focus — that is the whole point of cancelling mousedown — so a handler
	 * there would never see a key.
	 */
	useEffect(() => {
		if (!anchor || disabled || hidden) return;
		return editor.registerCommand(
			KEY_ESCAPE_COMMAND,
			(event: KeyboardEvent) => {
				event.preventDefault();
				event.stopPropagation();
				if (choosing) {
					setChoosing(false);
					return true;
				}
				editor.update(() => {
					let selection = $getSelection();
					if (!$isRangeSelection(selection)) return;
					let { key, offset, type } = selection.focus;
					selection.anchor.set(key, offset, type);
				});
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);
	}, [editor, anchor, disabled, hidden, choosing]);

	let place = useCallback(() => {
		let element = ref.current;
		if (!element || !anchor) return;
		let rect = nativeSelectionRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			setPosition(undefined);
			return;
		}
		// A DOMRect's sides are prototype getters, which `visibleAnchor`'s spread would drop.
		let liveAnchor = {
			bottom: rect.bottom,
			height: rect.height,
			left: rect.left,
			right: rect.right,
			top: rect.top,
			width: rect.width,
		};
		let viewport = editorSurfaceViewport(editor);
		let visible = visibleAnchor(liveAnchor, viewport);
		if (!visible) {
			setPosition(undefined);
			return;
		}
		// Measure the natural height: a stale cap from the last placement would shrink the menu.
		let capped = element.style.maxHeight;
		element.style.maxHeight = "";
		element.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
		let width = element.offsetWidth;
		let height = element.offsetHeight;
		element.style.maxHeight = capped;
		let centre = visible.left + visible.width / 2;
		// Below a touch selection the bubble also clears the system's end handle.
		let handle = coarse ? SELECTION_HANDLE : 0;
		let next = placeSurface(
			{
				bottom: visible.bottom + handle,
				height: visible.height + handle,
				left: centre - width / 2,
				right: centre + width / 2,
				top: visible.top,
				width: visible.width,
			},
			{ width, height },
			viewport,
			8,
			// A touch selection has the system's own callout above it, so the bubble goes
			// below, flipping above only when the visible viewport has no room there.
			coarse ? "below" : "above",
		);
		setPosition(current =>
			current?.left === next.left && current.top === next.top
				&& current.maxHeight === next.maxHeight
				? current
				: next
		);
	}, [anchor, coarse]);
	useLayoutEffect(place, [place, choosing, coarse]);

	useEffect(() => {
		if (!anchor) return;
		return listenToEditorGeometry(editor, place);
	}, [anchor, editor, place]);

	if (!anchor || disabled || hidden) return null;

	let comment = onComment && (
		<button
			type="button"
			aria-label="Comment on this passage"
			data-tooltip="Add comment"
			title="Comment on this passage"
			/*
			 * The passage is captured now, inside the click, because
			 * the composer this opens takes focus — and the selection
			 * goes with it. A draft that forgot what it was about the
			 * moment you started typing would be no use.
			 */
			onClick={() => {
				onComment();
				setAnchor(undefined);
				setPosition(undefined);
			}}
			className={`${CELL} ${CELL_OFF}`}
			data-press="small"
		>
			<MessagePlusIcon aria-hidden="true" />
		</button>
	);

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label="Text formatting"
			data-focus-boundary=""
			contentEditable={false}
			// No translate utilities here: placement belongs to the layout effect,
			// and Tailwind's would compose with its transform rather than replace it.
			className={`${SHELL} plan-formatting-toolbar flex max-w-[calc(100vw-1rem)] ${
				choosing ? "flex-col items-stretch" : "flex-wrap items-center"
			} gap-0.5 overflow-y-auto`}
			style={position
				? { top: position.top, left: position.left, maxHeight: position.maxHeight }
				: { top: anchor.bottom + 8, left: anchor.left, visibility: "hidden" }}
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
						onClick={() => convert(item.id)}
						className={`${ROW} gap-2 ${item.id === block ? CELL_ON : CELL_OFF}`}
						data-press="small"
					>
						<span
							aria-hidden="true"
							className="w-5 shrink-0 text-center text-xs font-medium text-text-quaternary"
						>
							{item.glyph}
						</span>
						<span>{item.label}</span>
					</button>
				)).concat(
					coarse
						? [
							<span key="rule" aria-hidden="true" className={DIVIDER} />,
							...MARKS.filter(mark => !PHONE_ROW.has(mark.format)).map(mark => (
								<button
									key={mark.format}
									type="button"
									aria-label={mark.label}
									aria-pressed={active.has(mark.format)}
									onClick={() => {
										setChoosing(false);
										editor.dispatchCommand(FORMAT_TEXT_COMMAND, mark.format);
									}}
									className={`${ROW} gap-2 ${active.has(mark.format) ? CELL_ON : CELL_OFF}`}
									data-press="small"
								>
									<span aria-hidden="true" className="flex w-5 shrink-0 justify-center">
										{mark.glyph}
									</span>
									<span>{mark.label}</span>
								</button>
							)),
						]
						: [],
				)
				: (
					<>
						{/* Commenting is what a reader on a phone selects text for, so it leads there. */}
						{comment && coarse && (
							<>
								{comment}
								<span aria-hidden="true" className={`${SEAM} plan-bubble-seam`} />
							</>
						)}
						<button
							type="button"
							aria-label={`Block type: ${describe(block).label}`}
							aria-expanded={false}
							data-tooltip="Block type"
							title={`${describe(block).label} — change block type`}
							onClick={() => setChoosing(true)}
							className={`plan-menu-cell plan-bubble-trigger inline-flex h-7 shrink-0 items-center gap-0.5 rounded-sm pl-2 pr-1 text-sm font-semibold ${CELL_OFF}`}
							data-press="small"
						>
							<span aria-hidden="true">{describe(block).short}</span>
							<ChevronIcon aria-hidden="true" className="size-3.5 rotate-90" />
						</button>

						<span aria-hidden="true" className={`${SEAM} plan-bubble-seam`} />

						{MARKS.filter(mark => !coarse || PHONE_ROW.has(mark.format)).map(mark => (
							<button
								key={mark.format}
								type="button"
								aria-label={mark.label}
								aria-pressed={active.has(mark.format)}
								data-tooltip={`${mark.label} ${mark.shortcut}`}
								title={`${mark.label} (${mark.shortcut})`}
								onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, mark.format)}
								className={`${CELL} ${active.has(mark.format) ? CELL_ON : CELL_OFF}`}
								data-press="small"
							>
								<span aria-hidden="true">{mark.glyph}</span>
							</button>
						))}

						<span aria-hidden="true" className={`${SEAM} plan-bubble-seam`} />

						<button
							type="button"
							aria-label={linked ? "Edit link" : "Add link"}
							title={`${linked ? "Edit link" : "Add link"} (${shortcut("K")})`}
							onClick={() => editor.dispatchCommand(OPEN_LINK_EDITOR_COMMAND, undefined)}
							className={`${CELL} ${CELL_OFF}`}
							data-press="small"
						>
							<LinkPlusIcon aria-hidden="true" />
						</button>

						{onComment && !coarse && (
							<>
								<span aria-hidden="true" className={`${SEAM} plan-bubble-seam`} />
								{comment}
							</>
						)}
					</>
				)}
		</div>
	);
}
