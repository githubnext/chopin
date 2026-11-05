/** When a lost connection is worth mentioning, shared by every surface that mentions it. */

import { useEffect, useState } from "react";

/** How long a lost connection stays silent, so a blip that recovers shows nothing. */
export const CONNECTION_GRACE = 1500;
/** How much longer it reads as reconnecting before it is called offline. */
export const CONNECTION_STALL = 5000;
/** Failed reconnect attempts in one outage before a person is offered a Retry of their own. */
export const RETRY_AFTER_FAILURES = 4;

/**
 * `none` while connected or inside the grace period, `reconnecting` once the
 * loss has outlasted it, and `offline` once it has outlasted the stall too.
 */
export type ConnectionNotice = "none" | "reconnecting" | "offline";

/** The notice for a connection that has been lost for `elapsed` milliseconds. */
export function connectionNotice(elapsed: number | undefined): ConnectionNotice {
	if (elapsed === undefined || elapsed < CONNECTION_GRACE) return "none";
	return elapsed < CONNECTION_GRACE + CONNECTION_STALL ? "reconnecting" : "offline";
}

/**
 * Whether a document is cut off from the server: the connection is being re-established
 * after a loss. A first connection that is merely slow is loading, not an outage, and a
 * refusal or a deleted document is not one the connection can recover from.
 */
export function isOffline(
	connection: "connecting" | "connected" | "reconnecting" | "denied" | "deleted" | "closed",
	outage: boolean,
): boolean {
	return outage && (connection === "connecting" || connection === "reconnecting");
}

/**
 * Whether an offline notice offers Retry: not while automatic reconnects are still working
 * through their backoff, which usually ends the outage unseen, but once enough have failed
 * that waiting is no longer the whole answer.
 */
export function offersRetry(failures: number): boolean {
	return failures >= RETRY_AFTER_FAILURES;
}

/**
 * What a screen reader is told as an offline notice changes. The notice speaks for itself as it
 * appears; leaving it is said once, politely, because the document was read-only and is not now.
 * A blip that never showed the notice never says it was over.
 */
export function offlineAnnouncement(wasShown: boolean, shown: boolean): string {
	return wasShown && !shown ? "Reconnected" : "";
}

/**
 * The notice for a connection that is `lost` right now.
 *
 * Only what is shown waits. Whatever has to act on the real connection, such
 * as reopening the document or sending, must keep reading it directly: a
 * reconnect inside the grace period never changes this value.
 */
export function useConnectionNotice(lost: boolean): ConnectionNotice {
	let [notice, setNotice] = useState<ConnectionNotice>("none");
	useEffect(() => {
		setNotice("none");
		if (!lost) return;
		let timers = [CONNECTION_GRACE, CONNECTION_GRACE + CONNECTION_STALL].map(delay =>
			setTimeout(() => setNotice(connectionNotice(delay)), delay)
		);
		return () => {
			for (let timer of timers) clearTimeout(timer);
		};
	}, [lost]);
	return lost ? notice : "none";
}
