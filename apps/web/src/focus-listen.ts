import { focusInputForKey, focusOriginFor } from "./focus-input";

import type { FocusInput } from "./focus-input";

const POINTER = "data-focus-pointer";

/**
 * Records whether focus last moved by keyboard or by pointer.
 *
 * Separate from the motion input, which also counts a pointer merely passing
 * over the page: a keyboard user whose mouse drifts must keep their focus ring.
 *
 * `focusOrigin` keeps the input that moved focus to the current element, so a
 * field clicked and then typed into still reads as reached by pointer.
 *
 * The focused element also carries `data-focus-pointer` while the last input was a
 * pointer, for the rule that hides a pressed control's ring. Written against the
 * root's attribute, that rule had the browser restyle every button and tabbable
 * element on the page each time input switched between keyboard and pointer: on a
 * long document, a quarter of a second on the first key after a click and the
 * first click after typing. Only the focused element can match it.
 */
export function listenForFocusInput(): () => void {
	let root = document.documentElement;
	let last: { target: unknown; origin: FocusInput | undefined } = {
		target: undefined,
		origin: undefined,
	};
	let marked: Element | null = null;
	let mark = () => {
		let next = root.dataset.focusInput === "pointer" ? document.activeElement : null;
		if (next === marked) return;
		marked?.removeAttribute(POINTER);
		(marked = next)?.setAttribute(POINTER, "");
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
		mark();
		tabbing = event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey;
	};
	let pointer = (event: PointerEvent) => {
		root.dataset.focusInput = "pointer";
		mark();
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
		mark();
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
}
