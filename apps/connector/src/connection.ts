import { ConnectorError } from "./mcp";
import type { remote } from "./mcp";
import type { Output } from "./output";
import { backoff, classifyConnectorError, delay, errorCode, HEALTHY_MS } from "./reconnect";
import type { Classify, ErrorClass } from "./reconnect";

type Api = Awaited<ReturnType<typeof remote>>;
export type WorkKind = "experiment" | "implementation";

/** Retries announced one by one; after these the connector stays quiet until it reconnects. */
const ANNOUNCED = 3;

/** The connector cannot continue: the reason is a sentence for the terminal. */
export class ConnectorStopped extends Error {
	constructor(readonly reason: Exclude<ErrorClass, "retry">, message: string) {
		super(message);
	}
}

function stopped(reason: Exclude<ErrorClass, "retry">, error: unknown) {
	let code = errorCode(error);
	let message = code === "machine-reauthorize"
		? "GitHub no longer accepts this machine's authorization. Run `chopin pair` to authorize it again."
		: reason === "revoked"
		? "This machine is no longer paired with Chopin. Run `chopin pair`, then connect again."
		: reason === "update-required"
		? "This Chopin server needs a newer connector. Update it, then connect again."
		: code === "repository-forbidden"
		? "Chopin refused the connection: you no longer have push access to this repository."
		: error instanceof Error
		? error.message
		: "Connector failed";
	return new ConnectorStopped(reason, message);
}

/** A failure's short cause for the terminal, such as a server's error code. */
function cause(error: unknown) {
	let code = errorCode(error);
	if (code) return code;
	if (error instanceof Error) return error.message.split("\n")[0]!.slice(0, 120);
	return "unknown error";
}

/**
 * Wait for work and run it, reconnecting after a transient failure: once at once when a working
 * connection drops, then with capped full-jitter backoff. The ladder starts over once a
 * connection has stayed up for a minute. It returns when `signal` aborts, after telling the
 * server it is leaving, and throws `ConnectorStopped` when retrying cannot help.
 */
export async function serveWork(options: {
	connect: () => Promise<Api>;
	run: (api: Api, kind: WorkKind, claim: unknown) => Promise<void>;
	signal: AbortSignal;
	output: Output;
	classify?: Classify;
	random?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
}) {
	let { signal, output } = options;
	let classify = options.classify ?? classifyConnectorError;
	let sleep = options.sleep ?? delay;
	let now = options.now ?? Date.now;
	let attempt = 0;
	/** Failed attempts since the connection was last up; zero while connected. */
	let failures = 0;
	let connectedAt: number | undefined;
	/** Whether any connection has been up, so a failure is a drop rather than a failed start. */
	let connected = false;
	while (!signal.aborted) {
		let api: Api | undefined;
		try {
			api = await options.connect();
			if (failures) output.reconnected();
			failures = 0;
			connected = true;
			connectedAt = now();
			await serve(api, options);
			break;
		} catch (error) {
			await api?.close().catch(() => {});
			if (signal.aborted) return;
			let kind = classify(error);
			if (kind !== "retry") throw stopped(kind, error);
			if (connectedAt !== undefined) {
				if (now() - connectedAt >= HEALTHY_MS) attempt = 0;
				connectedAt = undefined;
			}
			failures++;
			// A connection that was up and just failed its liveness check is tried again at once.
			let wait = failures === 1 && attempt === 0 && api ? 0 : backoff(attempt++, options.random);
			if (failures === 1) output.unreachable(cause(error), connected);
			if (failures <= ANNOUNCED) output.reconnecting(wait);
			else if (failures === ANNOUNCED + 1) output.stillReconnecting();
			if (wait) await sleep(wait, signal);
		}
	}
}

/** One connection's long poll for work; it returns only when `signal` aborts. */
async function serve(
	api: Api,
	options: {
		run: (api: Api, kind: WorkKind, claim: unknown) => Promise<void>;
		signal: AbortSignal;
	},
) {
	let { signal } = options;
	try {
		while (!signal.aborted) {
			let offered = await api.call("wait_for_work", {}, signal) as { id?: string; kind?: WorkKind };
			if (!offered.id || !offered.kind) continue;
			let claim;
			try {
				claim = await api.call(
					offered.kind === "implementation" ? "claim_implementation_build" : "claim_experiment",
					{ id: offered.id },
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
			await options.run(api, offered.kind, claim);
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	}
	// Leaving promptly matters more than being heard: the server also expires a silent connection.
	await api.call("disconnect_workspace", {}, AbortSignal.timeout(5000)).catch(() => {});
	await api.close().catch(() => {});
}
