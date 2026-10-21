import type { PlannerAssignment, PlannerControl } from "@chopin/protocol/connector";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { classifyConnectorError, connectorMessage, errorCode } from "./machine";
import type { Classify, ErrorClass } from "./machine";
import { ConnectorError } from "./mcp";
import type { remote } from "./mcp";
import type { Output } from "./output";
import {
	backoff,
	cancelled,
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
			? redacted(error.message)
			: "Connector failed");
	return new ConnectorStopped(reason, message);
}

const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const TOKEN =
	/\b(?:gh[opsur]_|github_pat_|chopin_[kmpr]_|sk-)[A-Za-z0-9_-]{8,}|\b(Bearer\s+)\S{8,}/g;

/**
 * `text` with URL credentials, token-shaped strings and each of the `secrets` it knows, such as
 * --env values and a Planner credential, masked, for the terminal. Secrets shorter than 8
 * characters are left, since they would mask ordinary words.
 */
export function redacted(text: string, secrets: string[] = []) {
	// The longest first, so one that contains another is masked whole.
	for (let secret of [...secrets].sort((a, b) => b.length - a.length)) {
		if (secret.length >= 8) text = text.replaceAll(secret, "[redacted]");
	}
	return text
		.replace(USERINFO, "$1[redacted]@")
		.replace(TOKEN, (_match, bearer?: string) => `${bearer ?? ""}[redacted]`);
}

/** An error message's first sentence, without the MCP client's prefixes or any credentials. */
function sentence(message: string) {
	return redacted(message).split("\n")[0]!
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
export function failureCause(error: unknown) {
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

/**
 * A failure's kind alone, without any of its message, so nothing it quotes can reach the
 * terminal: the HTTP status and the server's error code, else the network error's code, from the
 * error or anything it wraps as its `cause`.
 */
export function failureKind(error: unknown) {
	let code = errorCode(error);
	let current = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		code ??= errorCode(current);
		let own = (current as { code?: unknown }).code;
		// The MCP client's HTTP error carries its status as `code`; a refused registration as `status`.
		let status = current instanceof StreamableHTTPError
			? own
			: current instanceof ConnectorError
			? current.status
			: undefined;
		if (typeof status === "number" && status >= 100) {
			// A refusal without a code of its own is named `http-<status>`, which the status says.
			return code && code !== `http-${status}` ? `HTTP ${status} ${code}` : `HTTP ${status}`;
		}
		if (!code && typeof own === "string" && /^[A-Za-z_]+$/.test(own)) return own;
		if (!code && current.name === "TimeoutError") return "timed out";
		current = current.cause;
	}
	return code ?? "no answer";
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
	/**
	 * With a Planner command: the Planners Chopin asked this machine to run, polled for beside the
	 * work, and how to start and stop them.
	 */
	planners?: Planners;
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
	/** Runs in progress; a connection that drops under one is said, since Chopin may see a new one. */
	let running = 0;
	let run: typeof options.run = async (api, kind, claim) => {
		running++;
		try {
			return await options.run(api, kind, claim);
		} finally {
			running--;
		}
	};
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
	// keeps it, so the stop report and the disconnect that gives back claimed work still go out,
	// and so does one its caller gave up, as a run ending gives up its heartbeat.
	let link: Link = {
		async call(name, args, callSignal) {
			let api = current ?? await abandoned(
				connecting ??= open().then(value => {
					if (running) output.runReconnected();
					return current = value;
				}).finally(() => connecting = undefined),
				callSignal,
			);
			try {
				return await api.call(name, args, callSignal);
			} catch (error) {
				if (!signal.aborted && !cancelled(callSignal) && transient(classify(error))) {
					if (running && current === api) output.runConnectionLost(failureCause(error));
					drop(api);
				}
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
			await serveBoth(link, { ...options, run, classify });
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
			if (failures === 1) output.unreachable(failureCause(error), connected);
			if (failures <= ANNOUNCED) output.reconnecting(wait);
			else if (failures === ANNOUNCED + 1) output.stillReconnecting();
			if (wait) await sleep(wait, signal);
		}
	}
}

/** The Planners Chopin asks a connector to run, and how it starts and stops them. */
export type Planners = {
	/** The documents whose Planners it runs because Chopin asked, by id. */
	running(): string[];
	/** Run exactly these, starting the new ones and stopping the others. */
	assign(planners: PlannerAssignment[], stopped?: Record<string, string>): void;
	/** Chopin answered a poll that named `asked` without a change, so it wants exactly those. */
	unchanged?(asked: string[]): void;
};

/**
 * The work poll and, with `planners`, the Planner poll beside it on the same connection. A
 * failure that retrying cannot help ends both, after any run in progress finishes, and is thrown.
 */
async function serveBoth(
	link: Link,
	options: {
		run: (api: Link, kind: WorkKind, claim: unknown) => Promise<void>;
		signal: AbortSignal;
		planners?: Planners;
		classify: Classify;
		random?: () => number;
	},
) {
	let work = {
		signal: options.signal,
		run: (kind: WorkKind, claim: unknown) => options.run(link, kind, claim),
	};
	let planners = options.planners;
	if (!planners) return serve(link, work);
	let failed = new AbortController();
	let signal = AbortSignal.any([options.signal, failed.signal]);
	let failure: { error: unknown } | undefined;
	let fail = (error: unknown) => {
		failure ??= { error };
		failed.abort();
	};
	await Promise.all([
		serve(link, { ...work, signal }).catch(fail),
		pollPlanners(link, planners, signal, options.classify, options.random).catch(fail),
	]);
	if (failure && !options.signal.aborted) throw failure.error;
}

/**
 * The Planner poll (protocol 4): `wait_for_work` naming the Planners this connector runs, which
 * Chopin answers with the ones it should run once they differ, or else, when the wait ends, says
 * it is still waiting: it wants exactly the ones named. A transient failure is retried on the
 * reconnect backoff; another is thrown. It returns when `signal` aborts.
 */
async function pollPlanners(
	api: Link,
	planners: Planners,
	signal: AbortSignal,
	classify: Classify,
	random?: () => number,
) {
	let attempt = 0;
	while (!signal.aborted) {
		let answer: Partial<PlannerControl>;
		let asked = planners.running();
		try {
			answer = await api.call("wait_for_work", { planners: asked }, signal) as Partial<
				PlannerControl
			>;
			attempt = 0;
		} catch (error) {
			if (signal.aborted) return;
			if (!transient(classify(error))) throw error;
			await delay(backoff(attempt++, random), signal);
			continue;
		}
		if (signal.aborted) return;
		if (answer.kind === "planners" && Array.isArray(answer.planners)) {
			let stopped = answer.stopped && typeof answer.stopped === "object"
				? answer.stopped
				: undefined;
			planners.assign(answer.planners, stopped);
		} else planners.unchanged?.(asked);
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
