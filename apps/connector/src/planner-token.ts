import { rename, rm, writeFile } from "node:fs/promises";
import { classifyConnectorError, plannerCredential } from "./machine";
import { transient } from "./reconnect";

/** A Planner credential opens links for 15 minutes; this one is replaced 5 before that ends. */
export const RENEW_PLANNER_BEFORE_MS = 5 * 60_000;
/** How soon a renewal that failed for want of a connection is tried again. */
const RETRY_MS = 30_000;
/** How long Chopin issues a credential for, at most, whatever the machine's clock says. */
const LIFETIME_MS = 15 * 60_000;
/** The soonest the next renewal is asked for: a clock far ahead of Chopin's must not spin. */
const FLOOR_MS = 60_000;
/** How long one request for a credential may go unanswered. */
const REQUEST_MS = 15_000;
/** How many of the credentials handed out are remembered, to mask wherever one is printed. */
const REMEMBERED = 8;

export type PlannerTokenFile = {
	/** The 0600 file that always holds the newest credential and a newline. */
	file: string;
	/** Every credential handed out so far, to mask wherever the backend might print one. */
	secrets(): string[];
	/** Stops renewing and deletes the file. */
	stop(): Promise<void>;
};

/**
 * A running Planner backend's current credential, for as long as it runs. A backend whose link
 * dropped keeps its sessions and attaches again when it can, which may be hours later, when the
 * credential it was launched with is long expired, so the connector writes a fresh one to `file`
 * (mode 0600) before each expires and the backend reads it again whenever Chopin refuses its
 * upgrade. A renewal that fails for want of a connection is tried again and leaves the old file,
 * as a sleeping machine wakes to it; one Chopin refuses for good, such as a revoked machine or
 * a document it no longer lets this machine run, deletes the file and stops renewing.
 */
export async function plannerTokenFile(options: {
	url: string;
	machine: string;
	document: string;
	file: string;
	first: { token: string; expiresAt: number };
	/** How long before it expires a credential is replaced, and how soon a failed renewal is retried; for tests. */
	renewBeforeMs?: number;
	retryMs?: number;
	floorMs?: number;
}): Promise<PlannerTokenFile | undefined> {
	let { file } = options;
	let seen = [options.first.token];
	let save = async (token: string) => {
		let temporary = `${file}.${process.pid}.tmp`;
		// A leftover file would keep the mode it was made with, and the credential file its mode.
		await rm(temporary, { force: true });
		await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	};
	try {
		await save(options.first.token);
	} catch {
		return undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let renewing: Promise<void> | undefined;
	let stopped = false;
	let asking = new AbortController();
	let schedule = (expiresAt: number, delay?: number, floor = options.floorMs ?? FLOOR_MS) => {
		if (stopped) return;
		// The expiry is on Chopin's clock; a machine's clock that is ahead must not make the next
		// renewal due at once, nor one that is behind make it late.
		let wait = delay ?? Math.max(
			Math.min(expiresAt - Date.now(), LIFETIME_MS)
				- (options.renewBeforeMs ?? RENEW_PLANNER_BEFORE_MS),
			floor,
		);
		timer = setTimeout(() => renewing = renew(expiresAt), Math.min(Math.max(wait, 0), 2 ** 31 - 1));
		timer.unref?.();
	};
	let renew = async (expiresAt: number) => {
		try {
			let next = await plannerCredential(
				options.url,
				options.machine,
				options.document,
				AbortSignal.any([asking.signal, AbortSignal.timeout(REQUEST_MS)]),
			);
			if (stopped) return;
			seen.push(next.token);
			if (seen.length > REMEMBERED) seen.shift();
			await save(next.token);
			schedule(next.expiresAt);
		} catch (error) {
			if (stopped) return;
			if (transient(classifyConnectorError(error))) {
				schedule(expiresAt, options.retryMs ?? RETRY_MS);
			} else {
				stopped = true;
				await rm(file, { force: true });
			}
		}
	};
	// The launch's own credential may already be old, which is the one renewal due at once.
	schedule(options.first.expiresAt, undefined, 0);
	return {
		file,
		secrets: () => [...seen],
		async stop() {
			stopped = true;
			clearTimeout(timer);
			asking.abort();
			// A renewal still writing the file finishes before it goes.
			await renewing;
			await rm(file, { force: true });
		},
	};
}
