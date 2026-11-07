/**
 * How a tab comes back after its socket is lost, as `apps/web/src/wire.ts` decides it, so that a
 * load client reconnects on the same ladder a person's tab does and its gap means what a tab's
 * would. The decisions that `wire-loss.ts` already holds as pure functions are used as they are;
 * the three constants of the ladder itself are `wire.ts`'s own and are checked against it by
 * `ladder.test.ts`.
 */
import {
	lossOf,
	quietLeft,
	RESTART_JITTER_MS,
	restartRetryDelay,
} from "../../apps/web/src/wire-loss";

export { lossOf, RESTART_JITTER_MS };

export const BASE_DELAY = 500;
export const MAX_DELAY = 15_000;
/** When, after a loss, one attempt is guaranteed to start. */
export const RESCUE_AT = 1200;

export type Next = {
	/** Whether the attempt is preceded by the probe that asks why the connection was lost. */
	probe: boolean;
	/** How long to wait, after the probe if there is one, before the attempt. */
	delayMs: number;
};

/**
 * What to do after a loss, or after an attempt that did not open.
 *
 * A restart the server announced (a 1012 close or `session:restarting`) is not asked about first:
 * the first attempt comes after a jittered moment. Every later attempt probes first, and while the
 * restart's quiet lasts waits about a second, spread; after it, the ordinary backoff, held to the
 * rescue point when that is still ahead.
 */
export function next(input: {
	/** Whether the server announced this loss as a restart. */
	restarting: boolean;
	/** Attempts made since the loss, none of which opened. */
	attempts: number;
	lostAt: number;
	now: number;
	random: () => number;
	/** The spread of the first attempt after an announced restart; a tab's own is `RESTART_JITTER_MS`. */
	jitterMs?: number;
}): Next {
	let { restarting, attempts, lostAt, now, random, jitterMs = RESTART_JITTER_MS } = input;
	if (restarting && attempts === 0) {
		return { probe: false, delayMs: Math.floor(random() * jitterMs) };
	}
	let quiet = quietLeft(restarting, lostAt, now) > 0;
	if (quiet) return { probe: true, delayMs: restartRetryDelay(random()) };
	let delay = Math.min(BASE_DELAY * 2 ** attempts, MAX_DELAY) * (0.5 + random());
	let rescue = lostAt + RESCUE_AT - now;
	if (rescue > 0) delay = Math.min(delay, rescue);
	return { probe: true, delayMs: delay };
}
