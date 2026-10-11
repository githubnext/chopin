import { useEffect, useState, useSyncExternalStore } from "react";

import type { RefObject } from "react";

/** Follows `:root[data-keyboard-open]`, which the visual-viewport adapter keeps current. */
export function useKeyboardOpen(): boolean {
	return useSyncExternalStore(subscribe, current, () => false);
}

function subscribe(notify: () => void): () => void {
	let observer = new MutationObserver(notify);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-keyboard-open"],
	});
	return () => observer.disconnect();
}

function current(): boolean {
	return document.documentElement.hasAttribute("data-keyboard-open");
}

/** Whether focus is in a document editor inside `scope`: where the docked formatting acts. */
export function useEditorFocus(scope: RefObject<HTMLElement | null>): boolean {
	let [focused, setFocused] = useState(false);
	useEffect(() => {
		let update = () => {
			let active = document.activeElement;
			setFocused(
				!!active?.closest(".plan-content") && !!scope.current?.contains(active),
			);
		};
		update();
		// `focusout` fires before the next element takes focus, so settle after both events.
		let settle = () => queueMicrotask(update);
		document.addEventListener("focusin", settle);
		document.addEventListener("focusout", settle);
		return () => {
			document.removeEventListener("focusin", settle);
			document.removeEventListener("focusout", settle);
		};
	}, [scope]);
	return focused;
}
