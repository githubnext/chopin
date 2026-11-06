/**
 * What a lost socket and a refused probe mean for reconnecting, as plain decisions.
 *
 * Kept apart from `Wire` so they can be tested without a socket: the rules are the point, and
 * a deploy that went wrong because one of them was misread is not a failure to reproduce in a
 * browser.
 */

import { RESTART_QUIET_MS, SERVICE_RESTART } from "@chopin/protocol/restart";

/** The document was deleted, the server is restarting, or the connection was simply lost. */
export type Loss = "deleted" | "restart" | "lost";

/**
 * How the socket's close code reads. 1012 is the server saying it is restarting, so the client
 * comes back quietly; 4404 is a document that no longer exists, which no retry can reach.
 */
export function lossOf(code: number): Loss {
	if (code === 4404) return "deleted";
	return code === SERVICE_RESTART ? "restart" : "lost";
}

/**
 * Spread over this long so every tab of a restarted server does not return in the same instant.
 * The zero-downtime upgrades design (Stage 1, `apps/web` `wire.ts`) says to add no restart jitter,
 * as its proxy holds the first attempt until the new process is ready. It is added here on purpose:
 * a restart with no such proxy would have every tab return in the same instant.
 */
export const RESTART_JITTER_MS = 1000;

/** How long a restart waits before its first attempt, for a `random` in [0, 1). */
export function restartDelay(random: number): number {
	return Math.floor(random * RESTART_JITTER_MS);
}

/**
 * How long a client that has not got back in waits for its next attempt while a restart is
 * quiet, for a `random` in [0, 1): about a second, spread, instead of the ladder's wait, which
 * grows to several seconds and would find a server that is already back long after it was.
 */
export function restartRetryDelay(random: number): number {
	return 250 + Math.floor(random * 750);
}

/**
 * How much of a restart's quiet period is left, `now` and `lostAt` being `Date.now()` readings.
 * None for a loss that was not announced as a restart, none for a connection that is not lost, and
 * none once the period has passed, which is when the ordinary rules take over: the backoff, and
 * the outage the connection reports.
 */
export function quietLeft(restarting: boolean, lostAt: number | undefined, now: number): number {
	if (!restarting || lostAt === undefined) return 0;
	return Math.max(0, lostAt + RESTART_QUIET_MS - now);
}

export type Denial = "authentication" | "denied";

/**
 * Whether the probe's answer is a refusal, and which.
 *
 * A 401 always asks for a sign-in, even from a server that predates the marker. Any other 4xx
 * is Chopin refusing only if it says so: a proxy with no upstream answers 4xx too, and reading
 * that as a refusal would stop every open tab from ever reconnecting.
 */
export function refusalOf(status: number, marked: boolean): Denial | undefined {
	if (status === 401) return "authentication";
	return status >= 400 && status < 500 && marked ? "denied" : undefined;
}
