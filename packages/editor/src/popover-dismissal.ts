import { useEffect, useRef } from "react";

export type PopoverDismissal = "escape" | "outside";

/** True when the target is on none of the popover's regions (trigger, panel). */
export function isOutside(
	regions: readonly (Pick<Node, "contains"> | null | undefined)[],
	target: EventTarget | null,
): boolean {
	if (!target) return true;
	return !regions.some(region => region?.contains(target as Node));
}

/**
 * Close an open popover on Escape (capture phase, so nothing underneath also
 * reacts), on a pointerdown outside it, and when focus moves outside it. The
 * caller restores focus to the trigger for "escape".
 */
export function usePopoverDismissal(
	open: boolean,
	regions: () => readonly (Pick<Node, "contains"> | null | undefined)[],
	onDismiss: (reason: PopoverDismissal) => void,
): void {
	let latest = useRef({ regions, onDismiss });
	latest.current = { regions, onDismiss };

	useEffect(() => {
		if (!open) return;
		let keydown = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.isComposing
			) return;
			event.preventDefault();
			event.stopPropagation();
			latest.current.onDismiss("escape");
		};
		let away = (event: Event) => {
			if (isOutside(latest.current.regions(), event.target)) latest.current.onDismiss("outside");
		};
		document.addEventListener("keydown", keydown, true);
		document.addEventListener("pointerdown", away, true);
		document.addEventListener("focusin", away, true);
		return () => {
			document.removeEventListener("keydown", keydown, true);
			document.removeEventListener("pointerdown", away, true);
			document.removeEventListener("focusin", away, true);
		};
	}, [open]);
}
