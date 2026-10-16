import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ActualSizeIcon, CloseIcon, ExpandIcon, FitWidthIcon } from "@chopin/icons";

import { fitsLegibly } from "./diagram-fit";

import type { ReactNode, Ref } from "react";

/** What Tab can reach inside the sheet, including links a drawing may carry. */
const STOPS = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * A row under a diagram too dense for a phone's measure, offering it full
 * screen. Under the scroll lane rather than over it, so it never covers the
 * drawing or the fade that says there is more.
 *
 * Rendered only on a phone; the stylesheet also hides it wherever the
 * document has room.
 */
export function ExpandDiagram(
	{ onExpand, buttonRef }: { onExpand: () => void; buttonRef?: Ref<HTMLButtonElement> },
) {
	return (
		<div className="plan-diagram-actions" contentEditable={false} data-plan-chrome="expand">
			<button
				ref={buttonRef}
				type="button"
				className="btn btn-sm btn-ghost gap-1 text-text-tertiary"
				// Like the source toggle: a click in a non-editable island would
				// otherwise move the caret into the source beside it.
				onMouseDown={event => event.preventDefault()}
				onClick={onExpand}
			>
				<ExpandIcon aria-hidden="true" />
				Expand diagram
			</button>
		</div>
	);
}

/**
 * A row under a diagram too wide to read at the measure, on a desktop: its
 * whole shape scaled to the frame's width, or back to its drawn size. Visible
 * whenever the drawing scrolls, so a frame cut at its edge reads as more to see
 * even where scrollbars hide at rest, and a mouse without a sideways wheel
 * still reaches the end.
 */
export function FitDiagram({ fitted, onToggle }: { fitted: boolean; onToggle: () => void }) {
	return (
		<div className="plan-diagram-actions" contentEditable={false} data-plan-chrome="fit">
			<button
				type="button"
				className="btn btn-sm btn-ghost gap-1 text-text-tertiary"
				// Like the source toggle: a click in a non-editable island would
				// otherwise move the caret into the source beside it.
				onMouseDown={event => event.preventDefault()}
				onClick={onToggle}
			>
				{fitted ? <ActualSizeIcon aria-hidden="true" /> : <FitWidthIcon aria-hidden="true" />}
				{fitted ? "Actual size" : "Fit diagram to width"}
			</button>
		</div>
	);
}

/**
 * A full-screen sheet holding a second, larger reading of a diagram.
 *
 * A modal dialog, so the page behind is inert and focus stays inside; Escape
 * arrives as the dialog's cancel. The drawing scrolls natively, so a finger
 * pans it and a pinch zooms it the way it would anything else on the page.
 *
 * It opens at the drawing's authored size, where its labels are legible,
 * unless the whole drawing fits the screen at a legible scale; a toggle
 * switches between the two, like an image's lightbox.
 */
export function DiagramSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
	let dialog = useRef<HTMLDialogElement>(null);
	let close = useRef<HTMLButtonElement>(null);
	let [fitted, setFitted] = useState(false);

	useLayoutEffect(() => {
		let element = dialog.current;
		element?.showModal();
		close.current?.focus();
		let scroller = element?.querySelector<HTMLElement>(".plan-diagram-sheet-scroll");
		let authored = Number(scroller?.querySelector("svg")?.getAttribute("width"));
		if (scroller) {
			let style = getComputedStyle(scroller);
			let room = scroller.clientWidth - parseFloat(style.paddingInlineStart)
				- parseFloat(style.paddingInlineEnd);
			setFitted(fitsLegibly(room, authored));
		}
		return () => {
			if (element?.open) element.close();
		};
	}, []);

	return createPortal(
		<dialog
			ref={dialog}
			aria-label="Diagram"
			className="plan-diagram-sheet"
			data-focus-boundary=""
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
			// The page behind is inert, but Tab would still leave for the
			// browser's own chrome; keep it cycling through the sheet.
			onKeyDown={event => {
				if (event.key !== "Tab") return;
				let stops = [...event.currentTarget.querySelectorAll<HTMLElement>(STOPS)];
				let first = stops[0];
				let last = stops.at(-1);
				if (!first || !last) return;
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}}
		>
			<div className="plan-diagram-sheet-bar">
				<button
					type="button"
					className="plan-diagram-sheet-button btn btn-icon btn-secondary"
					aria-label={fitted ? "Actual size" : "Fit diagram to screen"}
					onClick={() => setFitted(!fitted)}
				>
					{fitted ? <ActualSizeIcon aria-hidden="true" /> : <FitWidthIcon aria-hidden="true" />}
				</button>
				<button
					ref={close}
					type="button"
					className="plan-diagram-sheet-button btn btn-icon btn-secondary"
					aria-label="Close diagram"
					onClick={onClose}
				>
					<CloseIcon aria-hidden="true" />
				</button>
			</div>
			<div
				className="plan-diagram-sheet-scroll"
				data-fit={fitted ? "" : undefined}
				role="region"
				aria-label="Diagram, scroll to pan"
				tabIndex={0}
			>
				{children}
			</div>
		</dialog>,
		document.body,
	);
}
