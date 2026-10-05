import { useEffect, useRef } from "react";

export type PopoverDismissal = "escape" | "outside";

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
				event.key !== "Escape" || event.defaultPrevented || event.isComposing
				|| event.keyCode === 229
			) return;
			event.preventDefault();
			event.stopPropagation();
			latest.current.onDismiss("escape");
		};
		let away = (event: Event) => {
			let current = latest.current;
			if (!current.regions().some(region => region?.contains(event.target as Node))) {
				current.onDismiss("outside");
			}
		};
		let controller = new AbortController();
		let options = { capture: true, signal: controller.signal };
		document.addEventListener("keydown", keydown, options);
		for (let name of ["pointerdown", "focusin"]) {
			document.addEventListener(name, away, options);
		}
		return () => controller.abort();
	}, [open]);
}
