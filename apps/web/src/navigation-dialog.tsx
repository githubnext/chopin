import { createPortal } from "react-dom";
import { useId, useRef } from "react";

import { NavigationFocusScope } from "./navigation-focus";

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import type { TransitionPresence } from "@chopin/editor/transition-presence";

export type NavigationDialogMotion = Pick<
	Exclude<TransitionPresence<unknown>, { phase: "closed" }>,
	"className" | "phase"
>;

/** Moves focus between a palette's search field and its enabled rows with the arrow keys. */
function movePaletteFocus(event: KeyboardEvent<HTMLElement>) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	let stops = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>(
			".navigation-palette-input, .navigation-palette-option:not(:disabled)",
		),
	);
	let index = stops.indexOf(document.activeElement as HTMLElement);
	if (index === -1) return;
	event.preventDefault();
	let next = stops[
		event.key === "ArrowDown"
			? Math.min(index + 1, stops.length - 1)
			: Math.max(index - 1, 0)
	]!;
	next.focus();
	next.scrollIntoView({ block: "nearest" });
}

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
					onKeyDown={palette ? movePaletteFocus : undefined}
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
