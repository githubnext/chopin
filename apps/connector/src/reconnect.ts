import { ConnectorError } from "./mcp";

/** The first retry waits up to a second; each later one doubles that ceiling. */
export const BASE_MS = 1000;
/** No retry waits longer than five minutes. */
export const CAP_MS = 300_000;

/** A full-jitter delay for a retry: uniform below `min(cap, base * 2^attempt)`. */
export function backoff(attempt: number, random = Math.random) {
	let ceiling = Math.min(CAP_MS, BASE_MS * 2 ** Math.min(attempt, 30));
	return Math.floor(random() * ceiling);
}

/**
 * What to do about a failed connector call: `retry` on a transient failure; otherwise stop,
 * because the machine was revoked, the server needs a newer connector, or retrying cannot help.
 */
export type ErrorClass = "retry" | "revoked" | "update-required" | "fatal";
export type Classify = (error: unknown) => ErrorClass;

/** Codes a restarting or briefly overloaded server answers with. */
const RETRY_CODES = new Set(["connection-unavailable", "unavailable", "owner-sign-in-required"]);
const REVOKED_CODES = new Set(["machine-revoked", "machine-reauthorize"]);

/** The server's error code, from a tool's `code: message` text or a refused call's JSON body. */
export function errorCode(error: unknown) {
	if (error instanceof ConnectorError) return error.code;
	let message = error instanceof Error ? error.message : "";
	return message.match(/"error":"([a-z][a-z0-9-]*)"/)?.[1];
}

export const classifyConnectorError: Classify = error => {
	let code = errorCode(error);
	if (code && REVOKED_CODES.has(code)) return "revoked";
	if (code === "connector-update-required") return "update-required";
	if (code && RETRY_CODES.has(code)) return "retry";
	// fetch rejects with a TypeError when the network or the server is unreachable, and with a
	// system error code when a socket breaks mid-request.
	if (error instanceof TypeError) return "retry";
	if (!(error instanceof Error)) return "fatal";
	if (error.name === "TimeoutError") return "retry";
	let status = (error as { code?: unknown }).code;
	if (typeof status === "string") {
		return /^(E[A-Z]+|Connection\w+|FailedToOpenSocket|UND_ERR\w*)$/.test(status)
			? "retry"
			: "fatal";
	}
	if (typeof status !== "number") return "fatal";
	// The MCP client's request timeout and closed connection, then an HTTP status refusal.
	if (status === -32001 || status === -32000) return "retry";
	return status >= 500 || status === 429 || status === 408 ? "retry" : "fatal";
};

/** A connection up this long has recovered; its next failure starts the backoff over. */
export const HEALTHY_MS = 60_000;

/** Wait `ms`, or less when `signal` aborts first. */
export function delay(ms: number, signal: AbortSignal) {
	return new Promise<void>(resolve => {
		let finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		let timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

/** How long a run keeps going without reaching Chopin before the connector stops its agent. */
export const RUN_GRACE_MS = 600_000;
/** Reports a run may hold back while Chopin is out of reach. */
export const MAX_PENDING_REPORTS = 16;

type Caller = {
	call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

/**
 * A run's reports to Chopin, which outlive a dropped connection. `attempt` makes one call;
 * `deliver` queues a report that must not be lost and retries it in order, on the reconnect
 * backoff, until it lands, Chopin refuses it, `stop` aborts, or the run has been out of contact
 * for its grace period.
 */
export function runReports(api: Caller, options: {
	stop: AbortSignal;
	graceMs?: number;
	random?: () => number;
	classify?: Classify;
	now?: () => number;
	/** Called once when Chopin stops answering, and once when it answers again. */
	lost?: () => void;
	back?: () => void;
}) {
	let classify = options.classify ?? classifyConnectorError;
	let now = options.now ?? Date.now;
	let graceMs = options.graceMs ?? RUN_GRACE_MS;
	let lostAt: number | undefined;
	let pending = 0;
	let queue: Promise<unknown> = Promise.resolve();
	let reports = {
		/** Out of contact for longer than the grace period. */
		expired: () => lostAt !== undefined && now() - lostAt >= graceMs,
		/** Whether a failed call may succeed later, so the run should carry on. */
		retryable: (error: unknown) => classify(error) === "retry" && !reports.expired(),
		async attempt(name: string, args: Record<string, unknown>) {
			try {
				let value = await api.call(name, args);
				if (lostAt !== undefined) {
					lostAt = undefined;
					options.back?.();
				}
				return value;
			} catch (error) {
				if (classify(error) === "retry" && lostAt === undefined) {
					lostAt = now();
					options.lost?.();
				}
				throw error;
			}
		},
		deliver(name: string, args: Record<string, unknown>) {
			if (pending >= MAX_PENDING_REPORTS) {
				return Promise.reject(new Error("Too many reports are waiting for Chopin."));
			}
			pending++;
			let result = queue.then(async () => {
				for (let retry = 0;; retry++) {
					try {
						return await reports.attempt(name, args);
					} catch (error) {
						if (!reports.retryable(error) || options.stop.aborted) throw error;
						await delay(backoff(retry, options.random), options.stop);
					}
				}
			}).finally(() => pending--);
			queue = result.catch(() => {});
			return result;
		},
	};
	return reports;
}
