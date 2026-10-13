import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONNECTOR_UPDATE_REQUIRED } from "@chopin/protocol/connector";
import { CONNECTOR_HEADERS, ConnectorError, refusal } from "./mcp";
import type { Output } from "./output";

/**
 * How people run this connector: the installed `chopin` binary, or the downloaded script, which
 * keeps Bun from loading the .env and bunfig.toml of the folder it runs in.
 */
export const SELF = Bun.isStandaloneExecutable
	? "chopin"
	: "bun --no-env-file --config=/dev/null connector.js";

const MESSAGES: Record<string, string> = {
	"machine-revoked": `This machine is no longer paired with Chopin. Run \`${SELF} pair\`, `
		+ "then connect again.",
	"machine-reauthorize": "GitHub no longer accepts this machine's authorization. "
		+ `Run \`${SELF} pair\` to authorize it again.`,
};

/** What a checkout tells Chopin when it connects. */
export type Checkout = { repository: string; commit: string; branch?: string; label: string };

type Stored = { servers: Record<string, { token: string; label: string }> };

/** The machine token file; it lives in the state directory and only its owner can read it. */
export function machineFile(directory: string) {
	return join(directory, "machine.json");
}

async function stored(directory: string): Promise<Stored> {
	try {
		let value = JSON.parse(await readFile(machineFile(directory), "utf8")) as Stored;
		return value && typeof value.servers === "object" ? value : { servers: {} };
	} catch {
		return { servers: {} };
	}
}

/**
 * Written to a private temporary file and renamed, so the token is never readable by others even
 * for a moment. On Windows the mode is ignored; the state directory under the user profile keeps
 * the profile's owner-only ACL.
 */
async function save(directory: string, value: Stored) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let path = machineFile(directory);
	let temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(value, null, "\t") + "\n", { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/**
 * Change machine.json under a lock file beside it, so connectors pairing or unpairing at once
 * never lose each other's tokens: the file is read again inside the lock and written whole.
 */
async function update(directory: string, change: (value: Stored) => void) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let lock = `${machineFile(directory)}.lock`;
	let deadline = Date.now() + LOCK_WAIT_MS;
	let file;
	for (let wait = 10;; wait = Math.min(wait * 2, 200)) {
		try {
			file = await open(lock, "wx", 0o600);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		if (await staleLock(lock)) {
			await rm(lock, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Another chopin process is changing ${machineFile(directory)}. `
					+ `If none is running, remove ${lock}.`,
			);
		}
		await Bun.sleep(wait);
	}
	try {
		await file.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }));
		let value = await stored(directory);
		change(value);
		await save(directory, value);
	} finally {
		await file.close().catch(() => {});
		await rm(lock, { force: true });
	}
}

/**
 * A lock is stale once it is older than any change takes, or, where processes can be checked,
 * once the process that holds it is gone. A lock still being written counts by its file's age.
 */
async function staleLock(path: string): Promise<boolean> {
	let held: { pid?: unknown; time?: unknown } | null = null;
	let modified: number | undefined;
	try {
		modified = (await stat(path)).mtimeMs;
		held = JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		// Gone already, so the next attempt takes it; otherwise it is still being written.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
	}
	let time = typeof held?.time === "number" ? held.time : modified;
	if (time !== undefined && Date.now() - time > LOCK_STALE_MS) return true;
	let pid = held?.pid;
	if (process.platform === "win32" || !Number.isSafeInteger(pid) || (pid as number) <= 0) {
		return false;
	}
	try {
		process.kill(pid as number, 0);
		return false;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** The machine token stored for one Chopin server. */
export async function machineToken(directory: string, origin: string) {
	return (await stored(directory)).servers[origin]?.token;
}

async function post(url: string, body: unknown, token?: string, signal?: AbortSignal) {
	let response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...CONNECTOR_HEADERS,
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
		signal,
	});
	let refused = await refusal(response);
	if (refused) throw refused;
	let value = await response.json().catch(() => ({})) as Record<string, unknown>;
	if (!response.ok) {
		let code = typeof value.error === "string" ? value.error : `http-${response.status}`;
		throw new ConnectorError(
			code,
			MESSAGES[code] ?? `Chopin refused the request (${code}).`,
			response.status,
		);
	}
	return value;
}

/**
 * Pair this machine with a Chopin server: print the link and code, wait for the owner to confirm
 * in the browser, and store the machine token. Returns undefined when stopped first.
 */
export async function pair(options: {
	url: string;
	label: string;
	directory: string;
	output: Output;
	signal: AbortSignal;
	checkout?: Omit<Checkout, "label">;
}) {
	let pairing = await post(
		options.url + "/api/connector/pairings",
		{ ...options.checkout, label: options.label },
		undefined,
		options.signal,
	) as { id: string; secret: string; url: string; code: string };
	options.output.pairing(
		options.checkout?.repository ?? options.label,
		pairing.url,
		pairing.code,
	);
	let token: string | undefined;
	while (!options.signal.aborted && !token) {
		let claim = await post(
			`${options.url}/api/connector/pairings/${pairing.id}/claim`,
			{ secret: pairing.secret },
			undefined,
			options.signal,
		);
		token = typeof claim.token === "string" ? claim.token : undefined;
		if (!token) await delay(1000, options.signal);
	}
	if (!token) return undefined;
	await update(options.directory, value => {
		value.servers[options.url] = { token, label: options.label };
	});
	return token;
}

/** Connect one checkout with the machine token; the returned token lasts while the server runs. */
export async function register(
	url: string,
	token: string,
	checkout: Checkout,
	signal?: AbortSignal,
) {
	let value = await post(url + "/api/connector/connections", checkout, token, signal);
	if (typeof value.token !== "string") throw new Error("Missing connection token.");
	return value.token;
}

/** A short-lived credential for this machine's Planner backend to attach one document. */
export async function plannerCredential(
	url: string,
	token: string,
	document: string,
	signal?: AbortSignal,
) {
	let value = await post(url + "/api/connector/planner", { document }, token, signal);
	if (typeof value.token !== "string" || typeof value.expiresAt !== "number") {
		throw new Error("Missing Planner credential.");
	}
	return { token: value.token, expiresAt: value.expiresAt };
}

/** Revoke this machine on the server and forget its token, even if the server already had. */
export async function unpair(url: string, directory: string): Promise<"unpaired" | "not-paired"> {
	let token = (await stored(directory)).servers[url]?.token;
	if (!token) return "not-paired";
	try {
		await post(url + "/api/connector/machine/revoke", {}, token);
	} catch (error) {
		if (classifyConnectorError(error) !== "revoked") throw error;
	}
	await forget(url, directory, token);
	return "unpaired";
}

/**
 * Delete the token stored for `url`, as Chopin revoked it or no longer accepts it. A pairing that
 * finished meanwhile stored a new token, which stays.
 */
export async function forget(url: string, directory: string, token: string) {
	await update(directory, value => {
		if (value.servers[url]?.token === token) delete value.servers[url];
	});
}

/**
 * What to do about a failed connector call: `retry` on a transient failure, and `forgotten` when
 * Chopin no longer recognizes the connection, as after a restart while connections live in
 * memory; that is retried too, but only for a while. Otherwise stop, because the machine was
 * revoked, the server needs a newer connector, or retrying cannot help.
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

/** The server's error code, from a tool's `code: message` text or a refused call's JSON body. */
export function errorCode(error: unknown) {
	if (error instanceof ConnectorError) return error.code;
	let message = error instanceof Error ? error.message : "";
	return message.match(/"error"\s*:\s*"([a-z][a-z0-9-]*)"/)?.[1];
}

/** What to tell the person when the server refused this machine, wherever the refusal came from. */
export function connectorMessage(error: unknown): string | undefined {
	let code = errorCode(error);
	return code ? MESSAGES[code] : undefined;
}

/**
 * How a connector should treat a failed request, from pairing, registering or any connector call:
 * retry transient failures, retry a forgotten connection for a while, stop and tell the person on
 * a revoked machine or an outdated connector, and stop on anything else.
 */
export const classifyConnectorError: Classify = error => {
	let code = errorCode(error);
	if (code && REVOKED_CODES.has(code)) return "revoked";
	if (code === CONNECTOR_UPDATE_REQUIRED) return "update-required";
	if (code && FORGOTTEN_CODES.has(code)) return "forgotten";
	if (code && RETRY_CODES.has(code)) return "retry";
	// fetch rejects with a TypeError when the network or the server is unreachable, and with a
	// system error code when a socket breaks mid-request.
	if (error instanceof TypeError) return "retry";
	if (!(error instanceof Error)) return "fatal";
	if (error.name === "TimeoutError") return "retry";
	// A refused pairing or registration carries its HTTP status; the MCP client's errors carry it,
	// or their own code, as `code`.
	let status = error instanceof ConnectorError
		? error.status
		: (error as { code?: unknown }).code;
	if (typeof status === "string") {
		return /^(E[A-Z]+|Connection\w+|FailedToOpenSocket|UND_ERR\w*)$/.test(status)
			? "retry"
			: "fatal";
	}
	if (typeof status !== "number") {
		return !code && /timed out|ECONNRESET|ECONNREFUSED|socket/i.test(error.message)
			? "retry"
			: "fatal";
	}
	// The MCP client's request timeout and closed connection, then an HTTP status refusal.
	if (status === -32001 || status === -32000) return "retry";
	if (status === 401) return "forgotten";
	return status >= 500 || status === 429 || status === 408 ? "retry" : "fatal";
};

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
