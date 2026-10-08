/** When a lost connection is worth mentioning, shared by every surface that mentions it. */

import { useEffect, useState } from "react";

/** How long a lost connection stays silent, so a blip that recovers shows nothing. */
export const CONNECTION_GRACE = 1500;
/** How much longer it reads as reconnecting before it is called offline. */
export const CONNECTION_STALL = 5000;

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
