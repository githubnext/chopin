/**
 * Formatting docked above a phone's keyboard while editing.
 *
 * The row follows what the writer is doing, as native editors' keyboard bars do: with only a
 * caret it offers blocks, text styles and history; with a selection it offers marks, a link and
 * a comment. Nothing in the row may take focus: the caret it acts on would go with it, and on a
 * phone so would the keyboard.
 *
 * Insert and Text style are the exception. They let the keyboard go on purpose and show their
 * choices at its height, then a choice gives the caret back. See `dock-panel.tsx`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import {
	CodeIcon,
	KeyboardIcon,
	LinkIcon,
	MessagePlusIcon,
	PlusIcon,
	RedoIcon,
	TextStyleIcon,
	UndoIcon,
} from "@chopin/icons";
import {
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$setSelection,
	FORMAT_TEXT_COMMAND,
	REDO_COMMAND,
	UNDO_COMMAND,
} from "lexical";

import { listenToHistory } from "../history";
import { $block } from "./bubble";
import { insertChoices, keyboardCover, styleChoices } from "./dock-panel";
import { $linkAt, OPEN_LINK_EDITOR_COMMAND } from "./link";

import type { ReactNode } from "react";
import type { RangeSelection } from "lexical";
import type { Block } from "./bubble";
import type { DockPanel, PanelChoice } from "./dock-panel";

type DockState = {
	bold: boolean;
	italic: boolean;
	strikethrough: boolean;
	code: boolean;
	block: Block;
	/** Some text is selected, so it can be marked, linked or commented on. */
	selected: boolean;
	/** The caret sits inside a link, which can be edited without selecting it. */
	inLink: boolean;
};

const IDLE: DockState = {
	bold: false,
	italic: false,
	strikethrough: false,
	code: false,
	block: "paragraph",
	selected: false,
	inLink: false,
};

/** Gives up waiting for the keyboard to go down or come back if the viewport never says so. */
const KEYBOARD_TIMEOUT = 1000;

/** Space kept between the caret's block and the top of an open panel. */
const CARET_CLEARANCE = 12;

export function FormatDock(
	{ disabled, onComment, onPanel, research = false }: {
		disabled?: boolean;
		onComment?: () => void;
		/** Told while a panel holds the keyboard's place, so the host keeps the dock up. */
		onPanel?: (open: boolean) => void;
		research?: boolean;
	},
) {
	let [editor] = useLexicalComposerContext();
	let [state, setState] = useState<DockState>(IDLE);
	let [history, setHistory] = useState({ undo: false, redo: false });
	let scroller = useRef<HTMLDivElement>(null);
	/** Which edges of the row have buttons scrolled past them; those edges fade. */
	let [edges, setEdges] = useState({ start: false, end: false });
	/**
	 * `opening` keeps the panel out of the layout until the keyboard has gone, or the bar would
	 * grow up the screen over the keyboard. `returning` keeps its space while the keyboard comes
	 * back over it.
	 */
	let [panel, setPanel] = useState<
		{ kind: DockPanel; block: Block; phase: "opening" | "open" | "returning" }
	>();
	let [panelHeight, setPanelHeight] = useState<number>();
	let panelElement = useRef<HTMLDivElement>(null);
	let toolbar = useRef<HTMLDivElement>(null);
	let saved = useRef<RangeSelection | null>(null);

	let sync = useCallback(() => {
		editor.getEditorState().read(() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return setState(IDLE);
			setState({
				bold: selection.hasFormat("bold"),
				italic: selection.hasFormat("italic"),
				strikethrough: selection.hasFormat("strikethrough"),
				code: selection.hasFormat("code"),
				block: $block(selection.anchor.getNode()),
				selected: !selection.isCollapsed(),
				inLink: selection.isCollapsed() && !!$linkAt(selection),
			});
		});
	}, [editor]);

	useEffect(() => {
		sync();
		return editor.registerUpdateListener(sync);
	}, [editor, sync]);

	useEffect(() => listenToHistory(editor, setHistory), [editor]);

	let open = !!panel;
	useEffect(() => {
		onPanel?.(open);
	}, [onPanel, open]);
	useEffect(() => () => onPanel?.(false), [onPanel]);

	// The panel waits for the keyboard on both sides: to go before it takes its space, and to come
	// back before it gives the space up.
	let phase = panel?.phase;
	useEffect(() => {
		if (phase !== "opening" && phase !== "returning") return;
		let settle = () =>
			phase === "opening"
				? setPanel(current => current && { ...current, phase: "open" })
				: setPanel(undefined);
		let check = () => {
			let up = !!keyboardCover(innerHeight, currentViewport());
			if (up === (phase === "returning")) settle();
		};
		let timer = setTimeout(settle, KEYBOARD_TIMEOUT);
		let stop = listenToViewportChanges(check);
		check();
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [phase]);

	// The caret's block stays above the panel, as it would above the keyboard.
	let shown = phase === "open";
	useLayoutEffect(() => {
		if (!shown) return;
		// Measured where the bar will rest once the keyboard has gone, not where it is now.
		let bar = toolbar.current?.offsetHeight;
		let height = panelElement.current?.offsetHeight;
		let top = bar === undefined || height === undefined ? undefined : innerHeight - height - bar;
		let key = saved.current?.anchor.key;
		let block = key ? editor.getElementByKey(key)?.closest(".plan-content > *") : undefined;
		let scroll = block?.closest<HTMLElement>("[data-plan-scroll]");
		if (top === undefined || !block || !scroll) return;
		let overlap = block.getBoundingClientRect().bottom + CARET_CLEARANCE - top;
		if (overlap > 0) scroll.scrollTop += overlap;
	}, [editor, shown]);

	let commentable = !!onComment && state.selected;
	useLayoutEffect(() => {
		let element = scroller.current;
		if (!element) return;
		let measure = () => {
			let start = element.scrollLeft > 1;
			let end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
			setEdges(current =>
				current.start === start && current.end === end ? current : { start, end }
			);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		element.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", measure);
		};
	}, [commentable, state.selected]);

	let openPanel = (kind: DockPanel) => {
		if (panel?.kind === kind && panel.phase !== "returning") return returnToEditor();
		let keyboard = keyboardCover(innerHeight, currentViewport());
		if (keyboard) setPanelHeight(keyboard);
		let next = keyboard ? "opening" as const : "open" as const;
		if (!panel) {
			saved.current = editor.getEditorState().read(() => {
				let selection = $getSelection();
				return $isRangeSelection(selection) ? selection.clone() : null;
			});
		}
		// The editor may let go of its selection once it loses focus; keep what the caret was in.
		let block = panel?.block ?? state.block;
		flushSync(() =>
			setPanel(current =>
				current && current.phase !== "returning"
					? { ...current, kind }
					: { kind, block, phase: next }
			)
		);
		// Focus leaves the editor, so iOS lowers the keyboard and the panel shows in its place.
		panelElement.current?.focus({ preventScroll: true });
	};

	/** Give the caret back where it was, inside the tap, so iOS raises the keyboard again. */
	let returnToEditor = (choice?: PanelChoice) => {
		let root = editor.getRootElement();
		let selection = saved.current;
		flushSync(() => setPanel(current => current && { ...current, phase: "returning" }));
		root?.focus({ preventScroll: true });
		editor.update(() => {
			if (
				selection && $getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)
			) {
				$setSelection(selection.clone());
			}
		}, { discrete: true });
		saved.current = null;
		choice?.run(editor);
	};

	let hideKeyboard = () => {
		setPanel(undefined);
		saved.current = null;
		let active = document.activeElement;
		if (active instanceof HTMLElement) active.blur();
	};

	let choices = panel?.kind === "insert"
		? insertChoices(research)
		: panel?.kind === "style"
		? styleChoices(panel.block)
		: [];
	let panelLabel = panel?.kind === "insert" ? "Insert block" : "Text style";

	return (
		<>
			<div
				aria-label="Formatting"
				className="plan-format-dock"
				contentEditable={false}
				data-focus-boundary=""
				// A press must not move focus out of the document, or the keyboard drops.
				onMouseDown={event => event.preventDefault()}
				onPointerDown={event => event.preventDefault()}
				ref={toolbar}
				role="toolbar"
			>
				<div
					className="plan-format-dock-scroll"
					data-more-end={edges.end || undefined}
					data-more-start={edges.start || undefined}
					ref={scroller}
				>
					{state.selected
						? (
							<>
								{/* First, so the narrowest phone never scrolls it out of reach. */}
								{commentable && (
									<DockButton
										label="Comment on this passage"
										onPress={() => onComment?.()}
									>
										<MessagePlusIcon size={18} />
									</DockButton>
								)}
								<DockButton
									disabled={disabled}
									label="Bold"
									onPress={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
									pressed={state.bold}
								>
									<span className="font-bold">B</span>
								</DockButton>
								<DockButton
									disabled={disabled}
									label="Italic"
									onPress={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
									pressed={state.italic}
								>
									<span className="italic">I</span>
								</DockButton>
								<DockButton
									disabled={disabled}
									label="Strikethrough"
									onPress={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}
									pressed={state.strikethrough}
								>
									<span className="line-through">S</span>
								</DockButton>
								<DockButton
									disabled={disabled}
									label="Inline code"
									onPress={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}
									pressed={state.code}
								>
									<CodeIcon size={18} />
								</DockButton>
								<DockButton
									disabled={disabled}
									label="Link"
									onPress={() => editor.dispatchCommand(OPEN_LINK_EDITOR_COMMAND, undefined)}
								>
									<LinkIcon size={18} />
								</DockButton>
							</>
						)
						: (
							<>
								<DockButton
									controls="plan-format-panel"
									disabled={disabled}
									expanded={panel?.kind === "insert" && panel.phase !== "returning"}
									label="Insert block"
									onPress={() => openPanel("insert")}
								>
									<PlusIcon size={18} />
								</DockButton>
								<DockButton
									controls="plan-format-panel"
									disabled={disabled}
									expanded={panel?.kind === "style" && panel.phase !== "returning"}
									label="Text style"
									onPress={() => openPanel("style")}
								>
									<TextStyleIcon size={18} />
								</DockButton>
								<DockButton
									disabled={disabled || !history.undo}
									label="Undo"
									onPress={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
								>
									<UndoIcon size={18} />
								</DockButton>
								<DockButton
									disabled={disabled || !history.redo}
									label="Redo"
									onPress={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
								>
									<RedoIcon size={18} />
								</DockButton>
								{state.inLink && (
									<DockButton
										disabled={disabled}
										label="Edit link"
										onPress={() => editor.dispatchCommand(OPEN_LINK_EDITOR_COMMAND, undefined)}
									>
										<LinkIcon size={18} />
									</DockButton>
								)}
							</>
						)}
				</div>
				{/* Pinned outside the scrolling row, so the way out is never cut off. */}
				<DockButton label="Hide keyboard" onPress={hideKeyboard}>
					<KeyboardIcon size={18} />
				</DockButton>
			</div>
			{panel && (
				<div
					aria-hidden={panel.phase === "returning" || undefined}
					aria-label={panelLabel}
					className="plan-format-panel"
					contentEditable={false}
					data-focus-boundary=""
					id="plan-format-panel"
					data-phase={panel.phase}
					inert={panel.phase === "returning" || undefined}
					onBlur={event => {
						// Leaving for anywhere but the dock, such as a tap on the page, closes it.
						let next = event.relatedTarget;
						if (panel.phase === "returning") return;
						if (next instanceof Node && event.currentTarget.parentElement?.contains(next)) return;
						saved.current = null;
						// A tap in the prose brings the keyboard back: hold the space until it arrives.
						let root = editor.getRootElement();
						if (next instanceof Node && root?.contains(next)) {
							setPanel(current => current && { ...current, phase: "returning" });
						} else {
							setPanel(undefined);
						}
					}}
					onKeyDown={event => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						returnToEditor();
					}}
					onMouseDown={event => event.preventDefault()}
					ref={panelElement}
					role="group"
					style={panelHeight && panel.phase !== "opening" ? { height: panelHeight } : undefined}
					tabIndex={-1}
				>
					<div className="plan-format-panel-grid">
						{choices.map(choice => (
							<button
								aria-pressed={choice.current}
								className="plan-format-panel-choice"
								disabled={disabled}
								key={choice.id}
								onClick={() => returnToEditor(choice)}
								type="button"
							>
								<span aria-hidden="true" className="plan-format-panel-glyph">
									{choice.glyph}
								</span>
								<span className="truncate">{choice.label}</span>
							</button>
						))}
					</div>
				</div>
			)}
		</>
	);
}

function DockButton(
	{ children, controls, disabled, expanded, label, onPress, pressed }: {
		children: ReactNode;
		controls?: string;
		disabled?: boolean;
		expanded?: boolean;
		label: string;
		onPress: () => void;
		pressed?: boolean;
	},
) {
	return (
		<button
			aria-controls={expanded ? controls : undefined}
			aria-expanded={expanded === undefined ? undefined : expanded}
			aria-label={label}
			aria-pressed={pressed}
			className="plan-format-dock-button"
			disabled={disabled}
			onClick={onPress}
			type="button"
		>
			{children}
		</button>
	);
}
