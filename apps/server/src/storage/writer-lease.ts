import type { Lease } from "./model";
import type { LeaseStore } from "./port";

export type WriterLeaseTiming = {
	/** How long each acquisition or renewal keeps the lease. */
	ttlMs: number;
	/** How often the holder renews. */
	renewMs: number;
	/** How long before expiry the holder stops if no renewal has succeeded. */
	safetyMs: number;
	/** How soon a failed renewal is retried. */
	retryMs: number;
};

/**
 * Keeps this process's writer lease: renews it on an interval, retries failed renewals,
 * and calls `lost` when the lease is lost or its safety deadline passes.
 */
export class WriterLease {
	/** The lease this process holds, or undefined once it is lost. */
	held: Lease | undefined;
	readonly #store: LeaseStore;
	readonly #timing: WriterLeaseTiming;
	readonly #lost: () => void;
	#renewal: ReturnType<typeof setInterval> | undefined;
	#watchdog: ReturnType<typeof setTimeout> | undefined;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#renewing: Promise<void> | undefined;
	#renewedAt = 0;
	#renewalStartedAt: number | undefined;
	#renewalError: unknown;

	constructor(store: LeaseStore, timing: WriterLeaseTiming, lost: () => void) {
		this.#store = store;
		this.#timing = timing;
		this.#lost = lost;
	}

	/** Holds a newly acquired lease, measuring its deadline from now. */
	hold(lease: Lease): void {
		this.held = lease;
		this.#renewedAt = Date.now();
	}

	/** Arms the safety deadline and starts renewing. */
	start(): void {
		this.#armWatchdog(this.#renewedAt);
		this.#renewal = setInterval(() => this.#renew(), this.#timing.renewMs);
	}

	/** Stops renewing and waits for any renewal in flight. */
	async stop(): Promise<void> {
		if (this.#renewal) clearInterval(this.#renewal);
		this.#renewal = undefined;
		if (this.#retry) clearTimeout(this.#retry);
		if (this.#watchdog) clearTimeout(this.#watchdog);
		await this.#renewing;
	}

	#renew(): void {
		if (!this.held || this.#renewing) return;
		if (this.#retry) clearTimeout(this.#retry);
		let started = Date.now();
		this.#renewalStartedAt = started;
		this.#renewing = this.#store.renew(this.held, this.#timing.ttlMs).then(renewed => {
			if (renewed) {
				this.held = renewed;
				this.#renewalError = undefined;
				// Once stopped, the owner is shutting down and has cleared the deadline for good.
				if (this.#renewal) this.#armWatchdog(started);
			} else {
				console.error("chopin: lost the storage writer lease");
				this.held = undefined;
				this.#lost();
			}
		}, err => {
			// A failed attempt is retried until the watchdog's deadline. Storage still refuses
			// every fenced write once the lease itself has expired or been taken over.
			this.#renewalError = err;
			let retrying = this.held !== undefined && this.#renewal !== undefined;
			console.warn(
				`chopin: could not renew the storage writer lease after ${Date.now() - started} ms${
					retrying ? "; retrying" : ""
				} -`,
				err,
			);
			if (retrying) this.#retry = setTimeout(() => this.#renew(), this.#timing.retryMs);
		}).finally(() => {
			this.#renewing = undefined;
			this.#renewalStartedAt = undefined;
		});
	}

	/** Arms the deadline from when the renewing statement was sent, the earliest its expiry can start. */
	#armWatchdog(renewedAt: number): void {
		if (this.#watchdog) clearTimeout(this.#watchdog);
		this.#renewedAt = renewedAt;
		let deadline = renewedAt + this.#timing.ttlMs - this.#timing.safetyMs;
		this.#watchdog = setTimeout(() => {
			let now = Date.now();
			let inFlight = this.#renewalStartedAt === undefined
				? "none"
				: `started ${now - this.#renewalStartedAt} ms ago`;
			console.error(
				"chopin: storage writer lease was not renewed before its safety deadline"
					+ ` (last renewal sent at ${new Date(this.#renewedAt).toISOString()},`
					+ ` ${now - this.#renewedAt} ms ago; watchdog ran ${now - deadline} ms late;`
					+ ` renewal in flight: ${inFlight}) - last renewal error:`,
				this.#renewalError ?? "none",
			);
			this.held = undefined;
			this.#lost();
		}, Math.max(0, deadline - Date.now()));
	}
}
