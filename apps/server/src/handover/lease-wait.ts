import type { Lease } from "../storage/model";
import type { LeaseStore } from "../storage/port";

export type LeaseWait = {
	name: string;
	/** The owner the lease is taken under once it is free. */
	owner: string;
	ttlMs: number;
	/** How long between plain reads of the lease. */
	pollMs: number;
	/** Aborting it ends the wait without a lease. */
	signal: AbortSignal;
	/** Called once, with the lease as the first read found it, when it is not free yet. */
	waiting?: (holder: Lease) => void;
	/** Called with each failed read; the wait goes on. */
	failed?: (error: unknown) => void;
};

/**
 * Waits for the lease with plain reads, then takes it.
 *
 * A read takes no lock, so polling never queues behind the holder's writes or delays them. The
 * locking `acquire` runs only once a read shows the lease released or expired, or never taken.
 * Another process may win that race, and then the wait goes on. Nothing the holder of a lease
 * arms (renewal, a deadline) exists before this returns it.
 */
export async function acquireWhenFree(
	store: LeaseStore,
	wait: LeaseWait,
): Promise<Lease | undefined> {
	let announced = false;
	while (!wait.signal.aborted) {
		try {
			let found = await store.peek(wait.name);
			if (!found || found.free) {
				let lease = await store.acquire(wait.name, wait.owner, wait.ttlMs);
				if (lease) return lease;
			} else if (!announced) {
				announced = true;
				wait.waiting?.(found.lease);
			}
		} catch (error) {
			wait.failed?.(error);
		}
		await pause(wait.pollMs, wait.signal);
	}
	return undefined;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		let done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		let timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}
