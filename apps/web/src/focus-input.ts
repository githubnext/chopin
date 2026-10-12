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
 * The input that brought focus to `target`. Focus returning to the element that
 * last had it, as when the window is re-activated, did not arrive anew, so it keeps
 * its origin rather than taking whatever key was pressed last.
 */
export function focusOriginFor(
	state: { target: unknown; origin: FocusInput | undefined },
	target: unknown,
	input: FocusInput | undefined,
): FocusInput | undefined {
	if (target === state.target) return state.origin;
	return input ?? state.origin;
}

/**
 * Records whether focus last moved by keyboard or by pointer.
 *
 * Separate from the motion input, which also counts a pointer merely passing
 * over the page: a keyboard user whose mouse drifts must keep their focus ring.
 *
 * `focusOrigin` keeps the input that moved focus to the current element, so a
 * field clicked and then typed into still reads as reached by pointer.
 */
export function useFocusInput(): void {
	useEffect(() => {
		let root = document.documentElement;
		let last: { target: unknown; origin: FocusInput | undefined } = {
			target: undefined,
			origin: undefined,
		};
		let setOrigin = (origin: FocusInput) => {
			last.origin = origin;
			root.dataset.focusOrigin = origin;
		};
		// Tab out to the browser's own controls is a departure; Shift+Tab back arrives anew.
		let tabbing = false;
		let keyboard = (event: KeyboardEvent) => {
			let input = focusInputForKey(event);
			if (input) root.dataset.focusInput = input;
			tabbing = event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey;
		};
		let pointer = (event: PointerEvent) => {
			root.dataset.focusInput = "pointer";
			tabbing = false;
			// A click inside the focused element moves no focus, but still answers the ring.
			if (event.target instanceof Node && document.activeElement?.contains(event.target)) {
				setOrigin("pointer");
			}
		};
		let focus = (event: FocusEvent) => {
			let origin = focusOriginFor(last, event.target, root.dataset.focusInput as FocusInput);
			last.target = event.target;
			if (origin) setOrigin(origin);
		};
		let blur = (event: FocusEvent) => {
			if (tabbing && event.relatedTarget === null) last.target = undefined;
		};
		window.addEventListener("keydown", keyboard, true);
		window.addEventListener("pointerdown", pointer, true);
		window.addEventListener("focusin", focus, true);
		window.addEventListener("focusout", blur, true);
		return () => {
			window.removeEventListener("keydown", keyboard, true);
			window.removeEventListener("pointerdown", pointer, true);
			window.removeEventListener("focusin", focus, true);
			window.removeEventListener("focusout", blur, true);
		};
	}, []);
}
