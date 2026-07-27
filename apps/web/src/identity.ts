/**
 * Who you are, and which room you are in.
 *
 * Identity is a GitHub handle and nothing more: unverified, claimed rather than
 * proven. It buys a stable cursor colour, a face in the presence row, and a
 * name against the decisions you make — none of which needs to be trustworthy
 * for a prototype, and all of which needs to be distinct.
 *
 * Storage is per-tab on purpose. A shared origin would make two tabs the same
 * person, which is exactly the case this has to support.
 */

const HANDLE_KEY = "chopin:handle";
const ACCESS_KEY = "chopin:key";
const DEFAULT_ROOM = "main";

const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function validHandle(value: string): boolean {
	return HANDLE.test(value);
}

/** The room named by the path, defaulting rather than presenting a chooser. */
export function room(): string {
	let match = /^\/r\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(location.pathname.toLowerCase());
	if (match?.[1]) return match[1];
	history.replaceState(null, "", `/r/${DEFAULT_ROOM}${location.search}`);
	return DEFAULT_ROOM;
}

/**
 * Read `?as=` and `?key=`, then tidy the address bar.
 *
 * The key is removed from the URL once captured: these sessions get screen
 * shared, and a secret sitting in the address bar for the duration is a poor
 * way to keep it. The handle stays — it is not sensitive and seeing it is
 * useful when you are looking at two windows.
 */
export function adopt(): void {
	let params = new URLSearchParams(location.search);

	let as = params.get("as");
	if (as && validHandle(as)) sessionStorage.setItem(HANDLE_KEY, as);

	let key = params.get("key");
	if (key) {
		sessionStorage.setItem(ACCESS_KEY, key);
		params.delete("key");
		let query = params.toString();
		history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
	}
}

export function handle(): string | undefined {
	let stored = sessionStorage.getItem(HANDLE_KEY);
	return stored && validHandle(stored) ? stored : undefined;
}

export function remember(value: string): void {
	sessionStorage.setItem(HANDLE_KEY, value);
}

export function key(): string | undefined {
	return sessionStorage.getItem(ACCESS_KEY) || undefined;
}
