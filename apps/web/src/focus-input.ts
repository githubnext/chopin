import { useEffect } from "react";

export type FocusInput = "keyboard" | "pointer";

/** Shortcut chords (Cmd+K, Ctrl+C) are not navigation, so they leave the modality alone. */
export function focusInputForKey(
	event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean },
): FocusInput | undefined {
	return event.metaKey || event.ctrlKey || event.altKey ? undefined : "keyboard";
}

/**
 * Records whether focus last moved by keyboard or by pointer.
 *
 * Separate from the motion input, which also counts a pointer merely passing
 * over the page: a keyboard user whose mouse drifts must keep their focus ring.
 */
export function useFocusInput(): void {
	useEffect(() => {
		let root = document.documentElement;
		let keyboard = (event: KeyboardEvent) => {
			let input = focusInputForKey(event);
			if (input) root.dataset.focusInput = input;
		};
		let pointer = () => {
			root.dataset.focusInput = "pointer";
		};
		window.addEventListener("keydown", keyboard, true);
		window.addEventListener("pointerdown", pointer, true);
		return () => {
			window.removeEventListener("keydown", keyboard, true);
			window.removeEventListener("pointerdown", pointer, true);
		};
	}, []);
}
