import { useEffect } from "react";

export type FocusInput = "keyboard" | "pointer";

const BARE_MODIFIERS = new Set(["Control", "Meta", "Alt", "Shift", "CapsLock", "Fn"]);

/**
 * Chords such as Alt+ArrowDown or Ctrl+Option+Arrow are keyboard navigation; only
 * pressing a modifier by itself says nothing about where focus is going.
 */
export function focusInputForKey(event: { key: string }): FocusInput | undefined {
	return BARE_MODIFIERS.has(event.key) ? undefined : "keyboard";
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
