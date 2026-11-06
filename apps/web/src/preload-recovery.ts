/**
 * What a page does when a chunk it needs cannot be loaded.
 *
 * A tab opened before a deploy asks for the chunks of its own build, and the server no longer has
 * them. Reloading fetches the new build, but only if the server answers with one, and only if the
 * page holds nothing a reload would throw away. A chunk also fails to load while the server is
 * restarting, and a reload then lands on the browser's error page; and it fails for reasons that
 * have nothing to do with a deploy, which the page's own recovery says what to do about, and a
 * reload of the same build would not cure.
 */

import { hasPendingWork } from "@chopin/protocol/pending-work";
import { entryOf } from "@chopin/protocol/restart";

const RELOADED_AT = "chopin:preload-reloaded-at";

/**
 * A reload that did not cure the failure is not repeated within this long, so a build that is
 * really broken cannot reload the page for ever.
 */
export const RELOAD_GAP_MS = 10_000;

/** Whether the server's page is of another build than the one running, both entries being known. */
export function isNewerBuild(running: string | undefined, served: string | undefined): boolean {
	return !!running && !!served && running !== served;
}

export type Reloading = {
	pending: () => boolean;
	/** Whether the server answers with a page of another build than this one, which a reload would show. */
	newer: () => Promise<boolean>;
	reload: () => void;
	now: () => number;
	/** Remembers when the page last reloaded; without it no reload is made. */
	storage: Pick<Storage, "getItem" | "setItem"> | undefined;
};

/**
 * Reload for a chunk that failed to load if nothing would be lost, the server answers with another
 * build and the last reload was not just now. Returns whether it did. The failure itself is left to
 * be thrown, as it was, to whatever was loading the chunk.
 */
export async function recoverFromPreloadError(reloading: Reloading): Promise<boolean> {
	if (reloading.pending() || !await reloading.newer()) return false;
	// Work may have begun while the server was asked.
	if (reloading.pending()) return false;
	try {
		let now = reloading.now();
		if (
			!reloading.storage || now - Number(reloading.storage.getItem(RELOADED_AT)) < RELOAD_GAP_MS
		) {
			return false;
		}
		reloading.storage.setItem(RELOADED_AT, String(now));
	} catch {
		return false;
	}
	reloading.reload();
	return true;
}

/** Listen for Vite's `vite:preloadError`, which it raises when a dynamic import fails to load. */
export function watchPreloadErrors(): void {
	let storage: Storage | undefined;
	try {
		storage = sessionStorage;
	} catch {
		// Storage the browser refuses: no reload can be remembered, so none is made.
	}
	let running = document.querySelector('script[type="module"][src]')?.getAttribute("src")
		?? undefined;
	addEventListener("vite:preloadError", () => {
		void recoverFromPreloadError({
			pending: hasPendingWork,
			newer: () =>
				fetch(location.href, { cache: "no-store" })
					.then(response => response.ok ? response.text() : "")
					.then(html => isNewerBuild(running, entryOf(html)), () => false),
			reload: () => location.reload(),
			now: Date.now,
			storage,
		});
	});
}
