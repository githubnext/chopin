/**
 * Links to Chopin's own pages, followed in the tab they are in.
 *
 * A link to a section of the document on show (`#overview`, or the document's own address with
 * that hash) goes there; a link to another document opens it in the app, at its section when it
 * names one. Anything else, another site included, is not the app's to follow. The shell follows
 * these for a click anywhere on the page, and the editor's Open and Chat's links ask here too, so
 * a link goes to the same place from wherever it is written.
 */

/** A page of the app, as the path after the origin. Every other path belongs to the server. */
const APP_PATH = /^\/(?:channels|connect|documents|machines|repositories)(?:\/|$)/;

/** The event the document on show listens for to note where its reader is before a jump. */
export const LEAVING_PLACE = "chopin:leaving-place";

/** Where on the history entry the document on show notes its reader's place. */
export const PLACE = "chopinPlace";

export type AppLink =
	/** A section of the page on show, by its hash: `#overview`. */
	| { kind: "section"; hash: string }
	/** Another page of the app, as path, query and hash. */
	| { kind: "page"; path: string };

/** Where `href` goes inside the app from the page at `here`, or nothing for any other address. */
export function appLink(
	href: string,
	here: { href: string; origin: string; pathname: string; search: string },
): AppLink | undefined {
	let to: URL;
	try {
		to = new URL(href, here.href);
	} catch {
		return undefined;
	}
	if (to.origin !== here.origin || (to.pathname !== "/" && !APP_PATH.test(to.pathname))) {
		return undefined;
	}
	return to.hash && to.pathname === here.pathname && to.search === here.search
		? { kind: "section", hash: to.hash }
		: { kind: "page", path: to.pathname + to.search + to.hash };
}

/**
 * Go to a section of the page on show, as a browser goes to a fragment: one step in history, so
 * Back returns, and a `hashchange` for whatever on the page follows its hash. The browser's own
 * scroll to an element of that id is not wanted (a heading has none, and an element of the app's
 * may), so the hash is pushed and the page that shows the section goes there itself.
 */
export function goToSection(hash: string): void {
	let oldURL = location.href;
	if (hash !== location.hash) {
		// Noted on the entry being left, so Back can return the reader to it. The new entry's copy
		// is never read: a place is only for an entry without a hash.
		dispatchEvent(new Event(LEAVING_PLACE));
		history.pushState(history.state, "", hash);
	}
	dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: location.href }));
}
