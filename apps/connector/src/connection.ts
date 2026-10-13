import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { classifyConnectorError, connectorMessage, errorCode } from "./machine";
import type { Classify, ErrorClass } from "./machine";
import { ConnectorError } from "./mcp";
import type { remote } from "./mcp";
import type { Output } from "./output";
import {
	backoff,
	CONNECT_TIMEOUT_MS,
	delay,
	FORGET_MS,
	forgottenMessage,
	HEALTHY_MS,
	transient,
} from "./reconnect";

type Api = Awaited<ReturnType<typeof remote>>;
/** The calls a run makes; they go to whichever connection is current. */
export type Link = Pick<Api, "call">;
export type WorkKind = "experiment" | "implementation";

/** Retries announced one by one; after these the connector stays quiet until it reconnects. */
const ANNOUNCED = 3;

/** The connector cannot continue: the reason is a sentence for the terminal. */
export class ConnectorStopped extends Error {
	constructor(readonly reason: Exclude<ErrorClass, "retry">, message: string) {
		super(message);
	}
}

function stopped(reason: Exclude<ErrorClass, "retry" | "forgotten">, error: unknown) {
	let code = errorCode(error);
	// A revoked machine is told to pair again. The server's refusal of an outdated connector says
	// which release to install, so it is shown as it came.
	let message = connectorMessage(error)
		?? (reason === "update-required"
			? error instanceof ConnectorError && error.status === 409
				? error.message
				: "This Chopin server needs a newer connector. Update it, then connect again."
			: code === "repository-forbidden"
			? "Chopin refused the connection: you no longer have push access to this repository."
			: error instanceof Error
			? error.message
			: "Connector failed");
	return new ConnectorStopped(reason, message);
}

/** An error message's first sentence, without the MCP client's prefixes. */
function sentence(message: string) {
	return message.split("\n")[0]!
		.replace(/^Streamable HTTP error:\s*/, "")
		.replace(/^Error POSTing to endpoint:\s*/, "")
		.replace(/\.(\s.*)?$/, "")
		.trim()
		.slice(0, 120);
}

/**
 * A failure's short cause for the terminal: the server's error code, else the HTTP status, else
 * the network error's code, each with the first sentence of its message. A gateway answering for
 * a restarting server sends no body, so the MCP client's own message can be empty.
 */
function cause(error: unknown) {
	let code = errorCode(error);
	if (code) return code;
	let fallback: string | undefined;
	let current = error;
	// fetch may wrap the socket's error as its `cause`.
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		let detail = sentence(current.message);
		let status = (current as { code?: unknown }).code;
		let name = current instanceof StreamableHTTPError && typeof status === "number" && status >= 100
			? `HTTP ${status}`
			: typeof status === "string"
			? status
			: undefined;
		if (name) return detail ? `${name}: ${detail}` : name;
		fallback ??= detail || undefined;
		current = current.cause;
	}
	return fallback ?? "connection closed";
}

/** `promise`, or its signal's reason once `signal` aborts first; the promise itself carries on. */
function abandoned<T>(promise: Promise<T>, signal?: AbortSignal) {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		let give = () => reject(signal.reason);
		if (signal.aborted) give();
		signal.addEventListener("abort", give, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", give));
	});
}

/**
 * Wait for work and run it, reconnecting after a transient failure: once at once when a working
 * connection drops, then with capped full-jitter backoff. The ladder starts over once a
 * connection has stayed up for a minute. It returns when `signal` aborts, after telling the
 * server it is leaving, and throws `ConnectorStopped` when retrying cannot help.
 */
export async function serveWork(options: {
	/**
	 * Opens a connection. Its signal aborts when the attempt runs out of time, and for a connection
	 * the connector itself opens also on Ctrl-C, which abandons the handshake; a run's report after
	 * Ctrl-C still reconnects.
	 */
	connect: (signal: AbortSignal) => Promise<Api>;
	run: (api: Link, kind: WorkKind, claim: unknown) => Promise<void>;
	signal: AbortSignal;
	output: Output;
	classify?: Classify;
	random?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	/** How long only `forgotten` refusals may last before the connector stops; two minutes. */
	forgetMs?: number;
	/** How long one attempt to connect may take before it counts as failed; 15 seconds. */
	connectTimeoutMs?: number;
}) {
	let { signal, output } = options;
	let classify = options.classify ?? classifyConnectorError;
	let sleep = options.sleep ?? delay;
	let now = options.now ?? Date.now;
	let forgetMs = options.forgetMs ?? FORGET_MS;
	let connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	let attempt = 0;
	/** Failed attempts since the connection was last up; zero while connected. */
	let failures = 0;
	let connectedAt: number | undefined;
	/** Since when every failure has been a `forgotten` refusal. */
	let forgottenSince: number | undefined;
	/** Whether any connection has been up, so a failure is a drop rather than a failed start. */
	let connected = false;
	let current: Api | undefined;
	let connecting: Promise<Api> | undefined;
	let drop = (api: Api) => {
		if (current === api) current = undefined;
		void api.close().catch(() => {});
	};
	// An attempt that gets no answer, as when the network drops and TCP waits on its handshake,
	// fails after the time limit, so the backoff advances instead of waiting out the outage. A
	// connection that opens after its attempt gave up is closed unused.
	let open = async (outer?: AbortSignal) => {
		let timeout = new AbortController();
		let timer = setTimeout(
			() =>
				timeout.abort(
					new DOMException(`no answer within ${connectTimeoutMs / 1000}s`, "TimeoutError"),
				),
			connectTimeoutMs,
		);
		let attempt = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
		try {
			let opening = options.connect(attempt);
			opening.then(late => attempt.aborted && void late.close().catch(() => {}), () => {});
			return await abandoned(opening, attempt);
		} finally {
			clearTimeout(timer);
		}
	};
	// A call that fails transiently drops its connection, so a run's next report connects anew,
	// as the token of a connection the server forgot is refused for good. A call Ctrl-C cut short
	// keeps it, so the stop report and the disconnect that gives back claimed work still go out.
	let link: Link = {
		async call(name, args, callSignal) {
			let api = current ?? await abandoned(
				connecting ??= open().then(value => current = value)
					.finally(() => connecting = undefined),
				callSignal,
			);
			try {
				return await api.call(name, args, callSignal);
			} catch (error) {
				if (!signal.aborted && transient(classify(error))) drop(api);
				throw error;
			}
		},
	};
	while (!signal.aborted) {
		let api: Api | undefined;
		try {
			api = current = await open(signal);
			if (failures) output.reconnected();
			failures = 0;
			forgottenSince = undefined;
			connected = true;
			connectedAt = now();
			await serve(link, { ...options, run: (kind, claim) => options.run(link, kind, claim) });
			// Leaving promptly matters more than being heard: a silent connection also expires.
			let last = current;
			if (last) {
				await last.call("disconnect_workspace", {}, AbortSignal.timeout(5000)).catch(() => {});
				drop(last);
			}
			break;
		} catch (error) {
			if (api) drop(api);
			if (signal.aborted) return;
			// A run that found its connection forgotten has already stopped its agent.
			if (error instanceof ConnectorStopped) throw error;
			let kind = classify(error);
			if (!transient(kind)) throw stopped(kind, error);
			// Only refusals from a server that forgot this connection, for the whole window: retrying
			// cannot help until someone pairs again. A network error or 5xx starts the window over.
			if (kind === "forgotten") forgottenSince ??= now();
			else forgottenSince = undefined;
			if (forgottenSince !== undefined && now() - forgottenSince >= forgetMs) {
				throw new ConnectorStopped("forgotten", forgottenMessage());
			}
			if (connectedAt !== undefined) {
				if (now() - connectedAt >= HEALTHY_MS) attempt = 0;
				connectedAt = undefined;
			}
			failures++;
			// A connection that was up and just failed its liveness check is tried again at once.
			let wait = failures === 1 && attempt === 0 && api ? 0 : backoff(attempt++, options.random);
			// The last try for a forgotten connection comes as its window ends.
			if (forgottenSince !== undefined) {
				wait = Math.min(wait, forgottenSince + forgetMs - now());
			}
			if (failures === 1) output.unreachable(cause(error), connected);
			if (failures <= ANNOUNCED) output.reconnecting(wait);
			else if (failures === ANNOUNCED + 1) output.stillReconnecting();
			if (wait) await sleep(wait, signal);
		}
	}
}

/** The long poll for work; it returns only when `signal` aborts. */
async function serve(
	api: Link,
	options: {
		run: (kind: WorkKind, claim: unknown) => Promise<void>;
		signal: AbortSignal;
	},
) {
	let { signal } = options;
	try {
		while (!signal.aborted) {
			let offered = await api.call("wait_for_work", {}, signal) as { id?: string; kind?: WorkKind };
			if (signal.aborted) break;
			if (!offered.id || !offered.kind) continue;
			let claim;
			try {
				claim = await api.call(
					offered.kind === "implementation" ? "claim_implementation_build" : "claim_experiment",
					{ id: offered.id },
					signal,
				);
			} catch (error) {
				if (
					error instanceof ConnectorError
					&& ["workspace-busy", "build-already-claimed", "invalid-state"].includes(error.code)
				) {
					await delay(1000, signal);
					continue;
				}
				throw error;
			}
			// A claim answered after Ctrl-C is not run; leaving disconnects, which gives it back.
			if (signal.aborted) break;
			await options.run(offered.kind, claim);
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	}
}
