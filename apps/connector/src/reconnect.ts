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
const REVOKED_CODES = ["machine-revoked", "machine-reauthorize"];

/** The server's error code, from a tool's `code: message` text or a refused call's JSON body. */
export function errorCode(error: unknown) {
	if (error instanceof ConnectorError) return error.code;
	let message = error instanceof Error ? error.message : "";
	return message.match(/"error":"([a-z][a-z0-9-]*)"/)?.[1];
}

export const classifyConnectorError: Classify = error => {
	let code = errorCode(error);
	if (code && REVOKED_CODES.includes(code)) return "revoked";
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
