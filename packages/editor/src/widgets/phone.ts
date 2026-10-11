import { useSyncExternalStore } from "react";

/**
 * The phone class: a coarse pointer on a small screen, in either orientation.
 *
 * Kept identical to the media query that gates wide-content styles in
 * styles.css. When the shell publishes `usePhone()` and `:root[data-phone]`
 * from `../pointer`, both switch to those and this file goes.
 */
export const PHONE_QUERY =
	"(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (max-height: 500px)";

function subscribe(change: () => void): () => void {
	let query = matchMedia(PHONE_QUERY);
	query.addEventListener("change", change);
	return () => query.removeEventListener("change", change);
}

export function usePhone(): boolean {
	return useSyncExternalStore(subscribe, () => matchMedia(PHONE_QUERY).matches, () => false);
}
