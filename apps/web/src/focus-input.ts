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
 * Records whether focus last moved by keyboard or by pointer (`listenForFocusInput`). Its
 * listeners load after the first render, outside the initial bundle; until they arrive, focus
 * rings show as they do for a keyboard.
 */
export function useFocusInput(): void {
	useEffect(() => {
		let stop: (() => void) | undefined;
		let gone = false;
		void import("./focus-listen").then(({ listenForFocusInput }) => {
			if (!gone) stop = listenForFocusInput();
		});
		return () => {
			gone = true;
			stop?.();
		};
	}, []);
}
