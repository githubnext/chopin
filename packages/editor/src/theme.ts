/**
 * The page's theme, light or dark, as the shell resolved it.
 *
 * `<html data-theme>` always says `light` or `dark`: a person's System choice is resolved against
 * `prefers-color-scheme` before the page paints and kept current while it is open. A document
 * follows it through the shared tokens with no script at all, code, diffs and SeeCode diagrams
 * included. What cannot is a drawing that bakes colours in when it is made: Mermaid's base theme,
 * which a diagram is drawn again with when the theme changes.
 */

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

export const THEME_ATTRIBUTE = "data-theme";

type Root = Pick<Element, "getAttribute">;

/** Anything but `dark` is light, as a page with no attribute is. */
export function readTheme(root: Root = document.documentElement): Theme {
	return root.getAttribute(THEME_ATTRIBUTE) === "dark" ? "dark" : "light";
}

type Observer = { observe(target: Root, options: MutationObserverInit): void; disconnect(): void };
type ObserverConstructor = new(callback: () => void) => Observer;

/**
 * Calls `onChange` each time the resolved theme changes, never for a write of the same value, and
 * returns what stops it. The observer is a parameter so this can be tested without a browser.
 */
export function watchTheme(
	onChange: (theme: Theme) => void,
	root: Root = document.documentElement,
	Watcher: ObserverConstructor = MutationObserver as unknown as ObserverConstructor,
): () => void {
	let last = readTheme(root);
	let observer = new Watcher(() => {
		let next = readTheme(root);
		if (next === last) return;
		last = next;
		onChange(next);
	});
	observer.observe(root, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
	return () => observer.disconnect();
}

function subscribe(notify: () => void): () => void {
	return watchTheme(notify);
}

/** The page's theme, following it as it changes. */
export function useTheme(): Theme {
	return useSyncExternalStore(subscribe, () => readTheme(), () => "light");
}
