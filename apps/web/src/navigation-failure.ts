/**
 * "Could not reach Chopin" and the connection banner (`chat/connection-banner.tsx`) tell one fact:
 * the server is out of reach. While the banner tells it, the navigation shell does not draw its
 * own error for it, and when the banner stops (the connection is back) the request that failed
 * during the outage is made again, so the notice goes because the server answered, not because it
 * was hidden. An error the server answered, or one the page raised, is no connection fact and is
 * always drawn.
 */

export type NavigationFailure = { reason: unknown; retry?: "refresh" | "visit" };

/** The request never reached the server: `fetch` rejects with a TypeError. */
export function unreached(failure: NavigationFailure): boolean {
	return failure.reason instanceof TypeError;
}
