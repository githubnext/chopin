import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CloseIcon, ExpandIcon, MinusIcon, PlusIcon } from "@chopin/icons";

import type { ReactNode } from "react";

/** What Tab stops on inside the sheet: its buttons, the scroller, and the drawing's own controls. */
const STOPS = "button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Below this, a fitted overview is too small to recognise anything in. */
const FIT_FLOOR = 0.2;

/**
 * Opens a diagram too dense for a phone's measure full screen.
 *
 * Hidden by the stylesheet wherever the document has room, so a wide screen
 * keeps the scroll lane and controls it already had.
 */
export function ExpandDiagram({ onExpand }: { onExpand: () => void }) {
	return (
		<button
			type="button"
			aria-label="Expand diagram"
			className="plan-diagram-expand btn btn-icon btn-secondary"
			contentEditable={false}
			// Chrome, so a click here is not read as a click into the drawing.
			data-plan-chrome="expand"
			// Like the source toggle: a click in a non-editable island would
			// otherwise move the caret into the source beside it.
			onMouseDown={event => event.preventDefault()}
			onClick={onExpand}
		>
			<ExpandIcon aria-hidden="true" />
		</button>
	);
}

/**
 * A full-screen sheet holding a second, larger reading of a diagram.
 *
 * A modal dialog, so the page behind is inert and focus stays inside; Escape
 * arrives as the dialog's cancel. The drawing scrolls natively, so a finger
 * pans it and a pinch zooms it the way it would anything else on the page.
 *
 * A `zoomable` drawing opens fitted to the width, for the whole shape, and
 * zooms to its authored size, where its labels are legible, like an image's
 * lightbox; one too wide to recognise when fitted opens at size. One with
 * zoom controls of its own leaves this off.
 */
export function DiagramSheet(
	{ onClose, zoomable = false, children }: {
		onClose: () => void;
		zoomable?: boolean;
		children: ReactNode;
	},
) {
	let dialog = useRef<HTMLDialogElement>(null);
	let close = useRef<HTMLButtonElement>(null);
	let [zoomed, setZoomed] = useState(false);

	useLayoutEffect(() => {
		let element = dialog.current;
		element?.showModal();
		close.current?.focus();
		// A drawing that would have to shrink past recognition opens at size.
		let scroller = element?.querySelector<HTMLElement>(".plan-diagram-sheet-scroll");
		let authored = Number(scroller?.querySelector("svg")?.getAttribute("width"));
		if (zoomable && scroller && authored > 0 && scroller.clientWidth / authored < FIT_FLOOR) {
			setZoomed(true);
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
				{zoomable && (
					<button
						type="button"
						className="plan-diagram-sheet-button btn btn-icon btn-secondary"
						aria-label={zoomed ? "Fit diagram to screen" : "Zoom in diagram"}
						aria-pressed={zoomed}
						onClick={() => setZoomed(!zoomed)}
					>
						{zoomed ? <MinusIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}
					</button>
				)}
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
				data-fit={zoomable && !zoomed ? "" : undefined}
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
