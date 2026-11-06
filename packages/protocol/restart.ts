/**
 * What a client needs to tell a server that is restarting from one that refused it.
 *
 * Both ends need these and must not disagree: the server closes with the one and marks the
 * other, and the client's reconnect is quiet only for a close and an answer it recognizes.
 */

/**
 * The close code of a socket the server ends because it is restarting (IANA "Service Restart").
 * The client reconnects quietly and keeps what it has not sent.
 */
export const SERVICE_RESTART = 1012;

/**
 * Set to `1` on every answer Chopin itself gives to a socket handshake it refuses. A 4xx without
 * it came from something in front of Chopin, such as a proxy with no upstream, and says nothing
 * about this person's access.
 */
export const REFUSAL_HEADER = "x-chopin-refusal";

/**
 * How long, in milliseconds, a restart is treated as a moment that will pass: the page says
 * nothing about it for this long, and a client that has not been let back in keeps trying about
 * once a second, so a server that is back is found at once, not at the end of a long backoff.
 *
 * This departs from the zero-downtime upgrades design (Stage 1, "What changes, by package",
 * `packages/editor`), which keeps the existing 1.5 s silence for a restart. That figure assumes a
 * second process already waiting to take over, which is not part of this change. A restart that
 * stops the old process before it starts the new one takes longer than 1.5 s, and a notice
 * within that time is not allowed to show.
 */
export const RESTART_QUIET_MS = 5000;

/** The query parameter of a socket's URL that names the build of the page that opens it. */
export const BUILD_PARAM = "build";

/**
 * The entry script a page's HTML loads, which names its build: any file of the build that changes
 * changes the entry's hash. Undefined when the HTML loads none.
 */
export function entryOf(html: string): string | undefined {
	for (let [tag] of html.matchAll(/<script\b[^>]*>/g)) {
		if (/\btype="module"/.test(tag)) {
			let source = /\bsrc="([^"]+)"/.exec(tag);
			if (source) return source[1];
		}
	}
	return undefined;
}
