/** When a lost connection is worth mentioning, shared by every surface that mentions it. */

import { RESTART_QUIET_MS } from "@chopin/protocol/restart";
import { useEffect, useState } from "react";

/** How long a lost connection stays silent, so a blip that recovers shows nothing. */
export const CONNECTION_GRACE = 1500;
/**
 * How long a loss stays silent when the server said it is restarting, which ends within
 * moments on its own, so a notice would only alarm. The connection raises no outage for such a
 * loss until `RESTART_QUIET_MS` has passed (see `Wire`), and what is shown follows the ordinary
 * grace from there, so every surface speaks at the same moment, as for any other loss. The
 * zero-downtime upgrades design keeps the 1.5 s grace for a restart; see `RESTART_QUIET_MS` for
 * why it cannot here.
 */
export const RESTART_GRACE = RESTART_QUIET_MS + CONNECTION_GRACE;
/** How much longer it reads as reconnecting before it is called offline. */
export const CONNECTION_STALL = 5000;
/** Failed reconnect attempts in one outage before a person is offered a Retry of their own. */
export const RETRY_AFTER_FAILURES = 4;

/**
 * `none` while connected or inside the grace period, `reconnecting` once the
 * loss has outlasted it, and `offline` once it has outlasted the stall too.
 */
export type ConnectionNotice = "none" | "reconnecting" | "offline";

/** How long a lost connection stays silent, `restarting` when the server said it is restarting. */
export function connectionGrace(restarting = false): number {
	return restarting ? RESTART_GRACE : CONNECTION_GRACE;
}

/** The notice for a connection that has been lost for `elapsed` milliseconds. */
export function connectionNotice(
	elapsed: number | undefined,
	restarting = false,
): ConnectionNotice {
	let grace = connectionGrace(restarting);
	if (elapsed === undefined || elapsed < grace) return "none";
	return elapsed < grace + CONNECTION_STALL ? "reconnecting" : "offline";
}

/**
 * Whether a document is cut off from the server. The outage the connection reports is the
 * authority, not its status: a lost connection can still read `connected` for as long as the
 * attempt to learn why it was lost has not answered, and the notice must not wait on that. A
 * first connection that is merely slow is loading, not an outage (none is reported), and a
 * refusal, a deleted document or one that was closed is not one the connection can recover from.
 */
export function isOffline(
	connection: "connecting" | "connected" | "reconnecting" | "denied" | "deleted" | "closed",
	outage: boolean,
): boolean {
	return outage && connection !== "denied" && connection !== "deleted" && connection !== "closed";
}

/** What `countGrace` needs of the page, so the rule it keeps can be tested without one. */
export type GraceClock = {
	/** Whether the page can be looked at: not hidden. */
	visible(): boolean;
	later(callback: () => void, ms: number): unknown;
	cancel(timer: unknown): void;
};

/**
 * The grace of one loss, counted only while the page can be looked at.
 *
 * A hidden page's timers run once a second and a frozen page's not at all, so a grace counted
 * there runs out in the same tick as the reconnect that would have ended the loss, and the page
 * says it is offline, locked, for the moment before the socket opens, to a page nobody can see. It
 * is counted from when the page is shown, thawed or restored, whole, while the loss lasts, and
 * `look` is how the page says so. A notice already shown is left as it is.
 */
export function countGrace(
	clock: GraceClock,
	restarting: boolean,
	say: (notice: ConnectionNotice) => void,
): { look(): void; stop(): void } {
	let grace = connectionGrace(restarting);
	let timers: unknown[] = [];
	let shown = false;
	let stop = () => {
		for (let timer of timers.splice(0)) clock.cancel(timer);
	};
	let start = () => {
		stop();
		if (!clock.visible()) return;
		timers = [grace, grace + CONNECTION_STALL].map(delay =>
			clock.later(() => {
				shown = true;
				say(connectionNotice(delay, restarting));
			}, delay)
		);
	};
	start();
	return {
		look() {
			if (!shown) start();
		},
		stop,
	};
}

/**
 * The notice for a connection that is `lost` right now.
 *
 * Only what is shown waits. Whatever has to act on the real connection, such
 * as reopening the document or sending, must keep reading it directly: a
 * reconnect inside the grace period never changes this value.
 */
export function useConnectionNotice(lost: boolean, restarting = false): ConnectionNotice {
	let [notice, setNotice] = useState<ConnectionNotice>("none");
	useEffect(() => {
		setNotice("none");
		if (!lost) return;
		let counting = countGrace(
			{
				visible: () => document.visibilityState !== "hidden",
				later: (callback, ms) => setTimeout(callback, ms),
				cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
			},
			restarting,
			setNotice,
		);
		// The page's own words for being shown, frozen, thawed and brought back from the cache.
		let looks: Array<[EventTarget, string]> = [
			[document, "visibilitychange"],
			[document, "freeze"],
			[document, "resume"],
			[window, "pageshow"],
		];
		for (let [target, event] of looks) target.addEventListener(event, counting.look);
		return () => {
			counting.stop();
			for (let [target, event] of looks) target.removeEventListener(event, counting.look);
		};
	}, [lost, restarting]);
	return lost ? notice : "none";
}
