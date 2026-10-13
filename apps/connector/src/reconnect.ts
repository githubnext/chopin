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
 * What to do about a failed connector call: `retry` on a transient failure, and `forgotten` when
 * Chopin no longer recognizes the connection, as after a restart while pairings live in memory;
 * that is retried too, but only for `FORGET_MS`. Otherwise stop, because the machine was revoked,
 * the server needs a newer connector, or retrying cannot help.
 */
export type ErrorClass = "retry" | "forgotten" | "revoked" | "update-required" | "fatal";
export type Classify = (error: unknown) => ErrorClass;

/**
 * Codes a restarting or briefly overloaded server answers with. `owner-sign-in-required` clears
 * once the owner signs in to Chopin again in a browser.
 */
const RETRY_CODES = new Set(["unavailable", "owner-sign-in-required"]);
/** Codes for a connection token Chopin no longer knows. */
const FORGOTTEN_CODES = new Set(["connection-unavailable", "authentication-required"]);
const REVOKED_CODES = new Set(["machine-revoked", "machine-reauthorize"]);

/** How long only `forgotten` refusals may last before the connector stops trying. */
export const FORGET_MS = 120_000;

/** Whether a failure of this class may pass, so the connector keeps trying for now. */
export function transient(kind: ErrorClass) {
	return kind === "retry" || kind === "forgotten";
}

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
	if (code && FORGOTTEN_CODES.has(code)) return "forgotten";
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
	if (status === 401) return "forgotten";
	return status >= 500 || status === 429 || status === 408 ? "retry" : "fatal";
};

/** The message for a connection Chopin forgot: connecting again registers it anew. */
export function forgottenMessage() {
	return "Chopin no longer recognizes this connection (it may have restarted). " + (
		typeof Bun !== "undefined" && Bun.isStandaloneExecutable
			? "Run `chopin connect` again."
			: "Run the connect command again."
	);
}

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
/** How long a run's last report may take, so Ctrl-C or a run ending is never held up by it. */
export const FINAL_REPORT_MS = 5000;

type Caller = {
	call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

/**
 * A run's reports to Chopin, which outlive a dropped connection. `attempt` makes one call;
 * `deliver` queues a report that must not be lost and retries it in order, on the reconnect
 * backoff, until it lands, Chopin refuses it, `stop` aborts, or the grace period runs out.
 * The grace period is a timer from the first failure to reach Chopin, cleared when Chopin answers.
 * When it fires, `signal` aborts, which ends in-flight calls and retry waits, and `expired` runs.
 */
export function runReports(api: Caller, options: {
	stop: AbortSignal;
	graceMs?: number;
	/** How long only `forgotten` refusals may last; two minutes by default. */
	forgetMs?: number;
	random?: () => number;
	classify?: Classify;
	now?: () => number;
	/** Called once when Chopin stops answering, and once when it answers again. */
	lost?: () => void;
	back?: () => void;
	/**
	 * Called once when the run has been out of reach for its whole grace period, or when Chopin
	 * has refused only as a server that forgot the connection does for `forgetMs`.
	 */
	expired?: (reason: "grace" | "forgotten") => void;
}) {
	let classify = options.classify ?? classifyConnectorError;
	let now = options.now ?? Date.now;
	let graceMs = options.graceMs ?? RUN_GRACE_MS;
	let forgetMs = options.forgetMs ?? FORGET_MS;
	let lostAt: number | undefined;
	let forgottenAt: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let forgetting: ReturnType<typeof setTimeout> | undefined;
	let gone = new AbortController();
	let pending = 0;
	let queue: Promise<unknown> = Promise.resolve();
	let expire = (reason: "grace" | "forgotten") => {
		clearTimeout(timer);
		clearTimeout(forgetting);
		gone.abort();
		options.expired?.(reason);
	};
	let reports = {
		/** Aborts when the grace period or the forgotten window runs out. */
		signal: gone.signal,
		/** Out of contact for the whole grace period, or forgotten by Chopin. */
		expired: () => gone.signal.aborted,
		/** Whether a failed call may succeed later, so the run should carry on. */
		retryable: (error: unknown) => transient(classify(error)) && !gone.signal.aborted,
		/** How long a retry may still wait: what is left of the grace period or forgotten window. */
		remaining: () =>
			Math.max(
				0,
				Math.min(
					lostAt === undefined ? graceMs : lostAt + graceMs - now(),
					forgottenAt === undefined ? forgetMs : forgottenAt + forgetMs - now(),
				),
			),
		/** One call, which `signal` or the grace period running out abandons. */
		async attempt(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
			try {
				let value = await api.call(name, args, signal);
				forgottenAt = undefined;
				clearTimeout(forgetting);
				if (lostAt !== undefined) {
					lostAt = undefined;
					clearTimeout(timer);
					options.back?.();
				}
				return value;
			} catch (error) {
				let kind = classify(error);
				if (transient(kind) && lostAt === undefined && !gone.signal.aborted) {
					lostAt = now();
					timer = setTimeout(() => expire("grace"), graceMs);
					options.lost?.();
				}
				// Any other failure, such as a network error, shows Chopin may only be out of reach.
				if (kind !== "forgotten") {
					forgottenAt = undefined;
					clearTimeout(forgetting);
				} else if (forgottenAt === undefined && !gone.signal.aborted) {
					forgottenAt = now();
					forgetting = setTimeout(() => expire("forgotten"), forgetMs);
				}
				throw error;
			}
		},
		deliver(name: string, args: Record<string, unknown>) {
			if (pending >= MAX_PENDING_REPORTS) {
				return Promise.reject(new Error("Too many reports are waiting for Chopin."));
			}
			pending++;
			let waiting = AbortSignal.any([options.stop, gone.signal]);
			let result = queue.then(async () => {
				for (let retry = 0;; retry++) {
					try {
						return await reports.attempt(name, args, waiting);
					} catch (error) {
						if (!reports.retryable(error) || waiting.aborted) throw error;
						await delay(Math.min(backoff(retry, options.random), reports.remaining()), waiting);
					}
				}
			}).finally(() => pending--);
			queue = result.catch(() => {});
			return result;
		},
		/**
		 * The run's last report, after those queued before it: one attempt bounded by
		 * `FINAL_REPORT_MS`, sent even after Ctrl-C or the grace period, so Chopin hears why.
		 */
		final(name: string, args: Record<string, unknown>) {
			let result = queue.then(() =>
				reports.attempt(name, args, AbortSignal.timeout(FINAL_REPORT_MS))
			);
			queue = result.catch(() => {});
			return result;
		},
		/** Stop the timers once the run is over. */
		close() {
			clearTimeout(timer);
			clearTimeout(forgetting);
		},
	};
	return reports;
}
