import { expect, test } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { classifyConnectorError } from "./machine";
import type { ErrorClass } from "./machine";
import { ConnectorError } from "./mcp";
import { backoff } from "./reconnect";

/** How the MCP client reports a refused HTTP call: the status and the server's JSON body. */
function http(status: number, code?: string) {
	return new StreamableHTTPError(
		status,
		`Error POSTing to endpoint: ${code ? JSON.stringify({ error: code }) : "Bad gateway"}`,
	);
}

test("transient failures retry, a forgotten connection retries for a while, and revocation, upgrades and lost access stop", () => {
	let refused = Object.assign(new TypeError("Unable to connect."), { code: "ConnectionRefused" });
	let cases: Array<[unknown, ErrorClass]> = [
		[refused, "retry"],
		[Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "retry"],
		[new DOMException("The operation timed out.", "TimeoutError"), "retry"],
		[new McpError(ErrorCode.RequestTimeout, "Request timed out"), "retry"],
		[http(502), "retry"],
		[http(503, "unavailable"), "retry"],
		[http(429), "retry"],
		[http(409, "connection-unavailable"), "forgotten"],
		[http(409, "owner-sign-in-required"), "retry"],
		[new ConnectorError("connection-unavailable", "connection-unavailable: gone"), "forgotten"],
		[http(401), "forgotten"],
		[http(401, "machine-revoked"), "revoked"],
		[http(401, "machine-reauthorize"), "revoked"],
		[new ConnectorError("machine-revoked", "machine-revoked: revoked"), "revoked"],
		[http(409, "connector-update-required"), "update-required"],
		[http(403, "repository-forbidden"), "fatal"],
		[new ConnectorError("repository-forbidden", "repository-forbidden: x"), "fatal"],
		[http(401, "authentication-required"), "forgotten"],
		[new Error("Missing connector response."), "fatal"],
	];
	expect(cases.map(([error]) => classifyConnectorError(error))).toEqual(
		cases.map(([, kind]) => kind),
	);
});

test("backoff draws a full-jitter delay below a doubling ceiling capped at five minutes", () => {
	expect([0, 1, 2, 3].map(attempt => backoff(attempt, () => 0.999_999))).toEqual([
		999,
		1_999,
		3_999,
		7_999,
	]);
	expect(backoff(0, () => 0)).toBe(0);
	expect(backoff(30, () => 0.999_999)).toBe(299_999);
	// A huge attempt count must not overflow into a longer or invalid wait.
	expect(backoff(10_000, () => 0.5)).toBe(150_000);
	for (let attempt = 0; attempt < 40; attempt++) {
		let value = backoff(attempt);
		expect(value).toBeGreaterThanOrEqual(0);
		expect(value).toBeLessThan(Math.min(300_000, 1000 * 2 ** attempt));
	}
});
