import { createPortal } from "react-dom";
import { useId, useRef } from "react";

import { NavigationFocusScope } from "./navigation-focus";

import type { ReactNode, RefObject } from "react";
import type { TransitionPresence } from "@chopin/editor/transition-presence";

export type NavigationDialogMotion = Pick<
	Exclude<TransitionPresence<unknown>, { phase: "closed" }>,
	"className" | "phase"
>;

/** A small modal primitive that owns the browser-only focus contract for navigation flows. */
export function NavigationDialog(
	{
		children,
		initialFocus,
		motion,
		onDismiss,
		palette = false,
		title,
	}: {
		children: ReactNode;
		initialFocus?: RefObject<HTMLElement | null>;
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		/** A command palette: its search field is the visible header, so the title is only named. */
		palette?: boolean;
		title: string;
	},
) {
	let dialog = useRef<HTMLDivElement>(null);
	let titleId = useId();
	let active = motion.phase !== "closing";

	return createPortal(
		<div
			aria-hidden={active ? undefined : "true"}
			className={`navigation-modal motion-modal ${motion.className}`}
			inert={!active}
			role="presentation"
		>
			<button
				aria-label={`Close ${title}`}
				className="navigation-modal-backdrop"
				data-press="none"
				onClick={onDismiss}
				type="button"
			/>
			<NavigationFocusScope active={active} initialFocus={initialFocus} onDismiss={onDismiss}>
				<div
					aria-labelledby={titleId}
					aria-modal="true"
					className={`navigation-modal-content${palette ? " navigation-palette" : ""}`}
					ref={dialog}
					role="dialog"
					tabIndex={-1}
				>
					<h2
						className={palette ? "sr-only" : "text-base font-semibold text-text-primary"}
						id={titleId}
					>
						{title}
					</h2>
					{children}
				</div>
			</NavigationFocusScope>
		</div>,
		document.body,
	);
}
