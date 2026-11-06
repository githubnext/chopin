import type { Router } from "./router";

export type ReadinessStatus = "starting" | "ready" | "draining";

/**
 * Whether this process may be sent traffic.
 *
 * Ready only once startup recovery has finished and the process holds the writer lease, and
 * never again once a drain has begun: a replacement waits for exactly this process to let go.
 */
export class Readiness {
	readonly #holdsLease: () => boolean;
	#started = false;
	#draining = false;

	constructor(holdsLease: () => boolean) {
		this.#holdsLease = holdsLease;
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
		return this.#started && this.#holdsLease() ? "ready" : "starting";
	}
}

function answer(request: Request, status: number, word: string): Response {
	return new Response(request.method === "HEAD" ? null : word, {
		status,
		headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
	});
}

/**
 * `GET /api/health/live` answers while the process runs, and `GET /api/health/ready` says
 * whether it may be sent traffic. Both are unauthenticated and say one word, nothing else.
 */
export function registerHealthRoutes(router: Router, readiness: Readiness): void {
	let live = (request: Request) => answer(request, 200, "live");
	let ready = (request: Request) => {
		let status = readiness.status();
		return answer(request, status === "ready" ? 200 : 503, status);
	};
	for (let method of ["GET", "HEAD"]) {
		router.on(method, "/api/health/live", live);
		router.on(method, "/api/health/ready", ready);
	}
}
