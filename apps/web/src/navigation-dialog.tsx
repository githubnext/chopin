import { createPortal } from "react-dom";
import { useId, useRef } from "react";

import { NavigationFocusScope } from "./navigation-focus";

import type { ReactNode, RefObject } from "react";

/** A small modal primitive that owns the browser-only focus contract for navigation flows. */
export function NavigationDialog(
	{
		children,
		initialFocus,
		onDismiss,
		title,
	}: {
		children: ReactNode;
		initialFocus?: RefObject<HTMLElement | null>;
		onDismiss: () => void;
		title: string;
	},
) {
	let dialog = useRef<HTMLDivElement>(null);
	let titleId = useId();

	return createPortal(
		<div className="navigation-modal" role="presentation">
			<button
				aria-label={`Close ${title}`}
				className="navigation-modal-backdrop"
				onClick={onDismiss}
				type="button"
			/>
			<NavigationFocusScope initialFocus={initialFocus} onDismiss={onDismiss}>
				<div
					aria-labelledby={titleId}
					aria-modal="true"
					className="navigation-modal-content"
					ref={dialog}
					role="dialog"
					tabIndex={-1}
				>
					<h2 className="text-xl font-semibold" id={titleId}>{title}</h2>
					{children}
				</div>
			</NavigationFocusScope>
		</div>,
		document.body,
	);
}
