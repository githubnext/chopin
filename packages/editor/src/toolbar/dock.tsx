/**
 * Formatting docked above a phone's keyboard while editing.
 *
 * The same commands as the selection bubble, in a fixed row the thumb can reach, so a phone
 * never shows two formatting surfaces at once. Nothing here may take focus: the caret it acts on
 * would go with it, and on a phone so would the keyboard.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { KeyboardIcon, LinkIcon, ListIcon, MessagePlusIcon, PlusIcon } from "@chopin/icons";
import { $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND } from "lexical";

import { $block, convertBlock } from "./bubble";
import { $linkAt, OPEN_LINK_EDITOR_COMMAND } from "./link";
import { OPEN_SLASH_MENU_COMMAND } from "./slash";

import type { ReactNode } from "react";
import type { Block } from "./bubble";

type DockState = {
	bold: boolean;
	italic: boolean;
	block: Block;
	/** Some text is selected, so it can be linked or commented on. */
	selected: boolean;
	/** A link can be added over a selection, or edited with the caret inside one. */
	linkable: boolean;
};

const IDLE: DockState = {
	bold: false,
	italic: false,
	block: "paragraph",
	selected: false,
	linkable: false,
};

/** Blocks the Heading button treats as already being a heading, so it turns them back. */
const HEADINGS = new Set<Block>(["h1", "h2", "h3", "h4", "h5", "h6"]);

export function FormatDock(
	{ disabled, onComment }: { disabled?: boolean; onComment?: () => void },
) {
	let [editor] = useLexicalComposerContext();
	let [state, setState] = useState<DockState>(IDLE);
	let scroller = useRef<HTMLDivElement>(null);
	/** Whether more buttons wait past the row's trailing edge, which then fades. */
	let [more, setMore] = useState(false);

	let sync = useCallback(() => {
		editor.getEditorState().read(() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return setState(IDLE);
			setState({
				bold: selection.hasFormat("bold"),
				italic: selection.hasFormat("italic"),
				block: $block(selection.anchor.getNode()),
				selected: !selection.isCollapsed(),
				linkable: !selection.isCollapsed() || !!$linkAt(selection),
			});
		});
	}, [editor]);

	useEffect(() => {
		sync();
		return editor.registerUpdateListener(sync);
	}, [editor, sync]);

	let commentable = !!onComment && state.selected;
	useLayoutEffect(() => {
		let element = scroller.current;
		if (!element) return;
		let measure = () => setMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		element.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", measure);
		};
	}, [commentable]);

	let heading = HEADINGS.has(state.block);
	let listed = state.block === "bullet";

	return (
		<div
			aria-label="Formatting"
			className="plan-format-dock"
			contentEditable={false}
			data-focus-boundary=""
			// A press must not move focus out of the document, or the keyboard drops.
			onMouseDown={event => event.preventDefault()}
			onPointerDown={event => event.preventDefault()}
			role="toolbar"
		>
			<div className="plan-format-dock-scroll" data-more={more || undefined} ref={scroller}>
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
					label="Heading"
					onPress={() => convertBlock(editor, state.block, heading ? "paragraph" : "h2")}
					pressed={heading}
				>
					<span className="font-semibold">H</span>
				</DockButton>
				<DockButton
					disabled={disabled}
					label="Bulleted list"
					onPress={() => convertBlock(editor, state.block, listed ? "paragraph" : "bullet")}
					pressed={listed}
				>
					<ListIcon size={18} />
				</DockButton>
				<DockButton
					disabled={disabled || !state.linkable}
					label="Link"
					onPress={() => editor.dispatchCommand(OPEN_LINK_EDITOR_COMMAND, undefined)}
				>
					<LinkIcon size={18} />
				</DockButton>
				{commentable && (
					<DockButton label="Comment on this passage" onPress={() => onComment?.()}>
						<MessagePlusIcon size={18} />
					</DockButton>
				)}
				<DockButton
					disabled={disabled}
					label="Insert block"
					onPress={() => editor.dispatchCommand(OPEN_SLASH_MENU_COMMAND, undefined)}
				>
					<PlusIcon size={18} />
				</DockButton>
			</div>
			{/* Pinned outside the scrolling row, so the way out is never cut off. */}
			<DockButton
				label="Hide keyboard"
				onPress={() => {
					let active = document.activeElement;
					if (active instanceof HTMLElement) active.blur();
				}}
			>
				<KeyboardIcon size={18} />
			</DockButton>
		</div>
	);
}

function DockButton(
	{ children, disabled, label, onPress, pressed }: {
		children: ReactNode;
		disabled?: boolean;
		label: string;
		onPress: () => void;
		pressed?: boolean;
	},
) {
	return (
		<button
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
