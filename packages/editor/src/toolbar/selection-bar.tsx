/**
 * What a phone offers for a selection, docked at the bottom of the screen.
 *
 * The system's own callout sits above a touch selection, and a floating bar
 * below it covers the lines the reader is still looking at. Docked in the thumb
 * zone it covers neither. Formatting is not here: on a phone that belongs to
 * editing, not to reading and commenting.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CheckIcon, CopyIcon, MessagePlusIcon } from "@chopin/icons";
import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import {
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_HIGH,
	COMMAND_PRIORITY_LOW,
	KEY_ESCAPE_COMMAND,
	SELECTION_CHANGE_COMMAND,
} from "lexical";

const COPIED_FOR = 1_200;

/** How much of the layout viewport the keyboard covers, so the bar can stand on it. */
function keyboardInset(): number {
	let viewport = currentViewport();
	return Math.max(0, Math.round(window.innerHeight - viewport.top - viewport.height));
}

export function SelectionBar(
	{ disabled, hidden, onComment }: {
		disabled?: boolean;
		hidden?: boolean;
		onComment?: () => void;
	},
) {
	let [editor] = useLexicalComposerContext();
	let [selected, setSelected] = useState(false);
	/** Set aside by Comment, whose sheet takes over, until the selection next moves. */
	let [dismissed, setDismissed] = useState(false);
	let [copied, setCopied] = useState(false);
	let [keyboard, setKeyboard] = useState(0);
	let copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	let sync = useCallback(() => {
		editor.getEditorState().read(() => {
			let selection = $getSelection();
			let next = !disabled && $isRangeSelection(selection) && !selection.isCollapsed();
			setSelected(next);
			if (!next) setCopied(false);
		});
	}, [editor, disabled]);

	useEffect(() => {
		sync();
		let stop = editor.registerCommand(
			SELECTION_CHANGE_COMMAND,
			() => {
				setDismissed(false);
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

	let shown = selected && !dismissed && !hidden && !disabled;

	useEffect(() => {
		if (!shown) return;
		let update = () => setKeyboard(keyboardInset());
		update();
		return listenToViewportChanges(update);
	}, [shown]);

	useEffect(() => () => clearTimeout(copiedTimer.current), []);

	// Escape lets go of the selection, as it does for the desktop toolbar.
	useEffect(() => {
		if (!shown) return;
		return editor.registerCommand(
			KEY_ESCAPE_COMMAND,
			(event: KeyboardEvent) => {
				event.preventDefault();
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
	}, [editor, shown]);

	if (!shown) return null;

	let copy = () => {
		let text = window.getSelection()?.toString() ?? "";
		if (!text) return;
		let done = () => {
			setCopied(true);
			clearTimeout(copiedTimer.current);
			copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FOR);
		};
		if (navigator.clipboard?.writeText) {
			void navigator.clipboard.writeText(text).then(done, () => {
				if (document.execCommand("copy")) done();
			});
		} else if (document.execCommand("copy")) done();
	};

	return (
		<div
			aria-label="Selection actions"
			className="plan-selection-bar"
			contentEditable={false}
			data-focus-boundary=""
			data-plan-selection-bar=""
			// Pressing a button must not take the selection it acts on.
			onMouseDown={event => event.preventDefault()}
			onPointerDown={event => {
				if (event.pointerType !== "mouse") event.preventDefault();
			}}
			role="toolbar"
			style={{ "--plan-selection-bar-keyboard": `${keyboard}px` } as CSSProperties}
		>
			{onComment && (
				<>
					<button
						aria-label="Comment on this passage"
						className="plan-selection-bar-action"
						data-press="small"
						onClick={() => {
							setDismissed(true);
							onComment();
						}}
						type="button"
					>
						<MessagePlusIcon aria-hidden="true" />
						Comment
					</button>
					<span aria-hidden="true" className="plan-selection-bar-seam" />
				</>
			)}
			<button
				aria-live="polite"
				className="plan-selection-bar-action"
				data-press="small"
				onClick={copy}
				type="button"
			>
				{copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon />}
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}
