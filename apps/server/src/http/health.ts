import type { Router } from "./router";

export type ReadinessStatus = "standby" | "starting" | "ready" | "draining";

/**
 * Whether this process may be sent traffic.
 *
 * It starts in `standby` when it waits beside another process for the writer lease, is
 * `starting` once it holds the lease, and is ready only once startup recovery has finished and
 * it still holds the lease. Never ready again once a drain has begun: a replacement waits for
 * exactly this process to let go.
 */
export class Readiness {
	readonly #holdsLease: () => boolean;
	#standby: boolean;
	#started = false;
	#draining = false;
	#refused = 0;

	constructor(holdsLease: () => boolean, options: { standby?: boolean } = {}) {
		this.#holdsLease = holdsLease;
		this.#standby = options.standby === true;
	}

	/** The process holds the writer lease: it is no longer waiting for it. */
	acquired(): void {
		this.#standby = false;
	}

	/** Startup recovery has finished. */
	started(): void {
		this.#started = true;
	}

	/** A drain has begun. Irreversible, because the process is on its way out. */
	draining(): void {
		this.#draining = true;
	}

	status(): ReadinessStatus {
		if (this.#draining) return "draining";
		if (this.#standby) return "standby";
		return this.#started && this.#holdsLease() ? "ready" : "starting";
	}

	/**
	 * Answers one readiness check. A check answered not ready once a drain has begun is counted:
	 * zero in the window between readiness going off and the listener stopping means no proxy
	 * checks readiness actively.
	 */
	check(): ReadinessStatus {
		let status = this.status();
		if (status === "draining") this.#refused++;
		return status;
	}

	/** How many readiness checks were answered not ready since the drain began. */
	get refusedWhileDraining(): number {
		return this.#refused;
	}
}

function answer(request: Request, status: number, word: string): Response {
	return new Response(request.method === "HEAD" ? null : word, {
		status,
		headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
	});
}

/**
 * `GET /api/health/live` answers while the process runs, with the word `standby` while it waits
 * for the writer lease and `live` otherwise, and `GET /api/health/ready` says whether it may be
 * sent traffic. Both are unauthenticated and say one word, nothing else.
 */
export function registerHealthRoutes(router: Router, readiness: Readiness): void {
	let live = (request: Request) =>
		answer(request, 200, readiness.status() === "standby" ? "standby" : "live");
	let ready = (request: Request) => {
		let status = readiness.check();
		return answer(request, status === "ready" ? 200 : 503, status);
	};
	for (let method of ["GET", "HEAD"]) {
		router.on(method, "/api/health/live", live);
		router.on(method, "/api/health/ready", ready);
	}
}
