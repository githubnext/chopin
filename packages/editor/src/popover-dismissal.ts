import { useEffect, useEffectEvent } from "react";

/**
 * Close an open popover on Escape (capture phase, so nothing underneath also
 * reacts), on a pointerdown outside it, and when focus moves outside it. The
 * caller restores focus to the trigger for "escape".
 */
export function usePopoverDismissal(
	open: boolean,
	inside: (target: Node) => boolean | undefined,
	onDismiss: (restoreFocus: boolean) => void,
): void {
	let listener = useEffectEvent((event: Event) => {
		if (event.type === "keydown") {
			let key = event as KeyboardEvent;
			if (
				key.key !== "Escape" || key.defaultPrevented || key.isComposing
				|| key.keyCode === 229
			) return;
			key.preventDefault();
			key.stopPropagation();
			onDismiss(true);
			return;
		}
		if (!inside(event.target as Node)) onDismiss(false);
	});

	useEffect(() => {
		if (!open) return;
		let events = ["keydown", "pointerdown", "focusin"];
		for (let name of events) document.addEventListener(name, listener, true);
		return () => {
			for (let name of events) document.removeEventListener(name, listener, true);
		};
	}, [open]);
}
