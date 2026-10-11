import { useSyncExternalStore } from "react";

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
