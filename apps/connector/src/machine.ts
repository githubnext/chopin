import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
	let value = await stored(options.directory);
	value.servers[options.url] = { token, label: options.label };
	await save(options.directory, value);
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

/** Revoke this machine on the server and forget its token, even if the server already had. */
export async function unpair(url: string, directory: string): Promise<"unpaired" | "not-paired"> {
	let value = await stored(directory);
	let token = value.servers[url]?.token;
	if (!token) return "not-paired";
	try {
		await post(url + "/api/connector/machine/revoke", {}, token);
	} catch (error) {
		if (classifyConnectorError(error) !== "revoked") throw error;
	}
	delete value.servers[url];
	await save(directory, value);
	return "unpaired";
}

/**
 * How a connector should treat a failed request: retry transient failures, stop and tell the user
 * on a revoked machine or an outdated connector, and stop on anything else.
 */
export function classifyConnectorError(
	error: unknown,
): "retry" | "revoked" | "update-required" | "fatal" {
	if (error instanceof TypeError) return "retry";
	if (!(error instanceof Error)) return "fatal";
	let code = error instanceof ConnectorError
		? error.code
		: error.message.match(/"error"\s*:\s*"([a-z0-9-]+)"/)?.[1];
	let raw = (error as Error & { code?: unknown }).code;
	let status = error instanceof ConnectorError
		? error.status
		: typeof raw === "number"
		? raw
		: undefined;
	if (code === "machine-revoked" || code === "machine-reauthorize") return "revoked";
	if (code === "connector-update-required") return "update-required";
	if (
		code && ["connection-unavailable", "unavailable", "owner-sign-in-required"].includes(code)
	) return "retry";
	if (status !== undefined && (status >= 500 || status === 429 || status === 408)) return "retry";
	if (/timed out|ECONNRESET|ECONNREFUSED|socket/i.test(error.message) && !code) return "retry";
	return "fatal";
}

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
