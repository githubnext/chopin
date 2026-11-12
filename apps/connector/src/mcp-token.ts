import { rename, rm, writeFile } from "node:fs/promises";
import { classifyConnectorError, machineMcpToken } from "./machine";
import { transient } from "./reconnect";

/** A run's token for Chopin's tools lasts an hour; it is replaced 10 minutes before that ends. */
export const RENEW_MCP_BEFORE_MS = 10 * 60_000;
/** How soon a renewal that failed for want of a connection is tried again. */
const RETRY_MS = 30_000;
/** How long one request for a token may go unanswered. */
const REQUEST_MS = 15_000;
/** How many of the tokens handed out are remembered, to mask wherever one is printed. */
const REMEMBERED = 8;

/** What a launch shows Chopin to get its token for Chopin's tools: its own credential. */
export type McpCredential = { planner: string } | { run: string };

export type McpTokenFile = {
	/** The 0600 file that holds the current token and a newline, while there is one. */
	file: string;
	/** Asks for a new token with the launch's credential as it is now, as a Planner's is renewed. */
	renew(credential: McpCredential): Promise<void>;
	/** Every token handed out so far, to mask wherever the launch might print one. */
	secrets(): string[];
	/** Stops renewing and deletes the file. */
	stop(): Promise<void>;
};

/**
 * The token a launch's backend shows Chopin's own tools at `/mcp`: a Chopin credential that reaches
 * only those tools, only for the launch's documents and only while it lasts, never a GitHub token
 * or the launch's own credential. Minted from the launch's credential (`credential`), written to
 * `file` (mode 0600) and replaced before it expires: a run's on its own schedule, a Planner's
 * whenever its credential is renewed (`renew`), as it lasts no longer than that. Chopin refusing
 * one deletes the file, so the tools refuse too, but the launch goes on; one out of reach is tried
 * again, and its token is deleted once it has expired.
 */
export async function mcpTokenFile(options: {
	url: string;
	machine: string;
	file: string;
	credential: McpCredential;
	/** Whether this launch renews its token on its own schedule: a run does, a Planner doesn't. */
	scheduled: boolean;
	renewBeforeMs?: number;
	retryMs?: number;
}): Promise<McpTokenFile> {
	let { file } = options;
	let seen: string[] = [];
	let credential = options.credential;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: Promise<void> | undefined;
	let stopped = false;
	let asking = new AbortController();
	/** When the token in the file expires, once there is one. */
	let expires: number | undefined;
	let save = async (token: string) => {
		let temporary = `${file}.${process.pid}.tmp`;
		await rm(temporary, { force: true });
		await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	};
	let schedule = (delay: number) => {
		if (stopped) return;
		clearTimeout(timer);
		timer = setTimeout(() => void ask(), Math.min(Math.max(delay, 0), 2 ** 31 - 1));
		timer.unref?.();
	};
	let ask = () =>
		current = (async () => {
			try {
				let next = await machineMcpToken(
					options.url,
					options.machine,
					credential,
					AbortSignal.any([asking.signal, AbortSignal.timeout(REQUEST_MS)]),
				);
				if (stopped) return;
				seen.push(next.token);
				if (seen.length > REMEMBERED) seen.shift();
				await save(next.token);
				expires = next.expiresAt;
				if (options.scheduled) {
					schedule(next.expiresAt - Date.now() - (options.renewBeforeMs ?? RENEW_MCP_BEFORE_MS));
				}
			} catch (error) {
				if (stopped) return;
				if (transient(classifyConnectorError(error))) {
					// Kept while it lasts; a stale one would only be refused.
					if (expires !== undefined && Date.now() >= expires) await rm(file, { force: true });
					schedule(options.retryMs ?? RETRY_MS);
				} else {
					clearTimeout(timer);
					await rm(file, { force: true });
				}
			}
		})();
	await ask();
	return {
		file,
		async renew(next) {
			credential = next;
			await current;
			if (!stopped) await ask();
		},
		secrets: () => [...seen],
		async stop() {
			stopped = true;
			clearTimeout(timer);
			asking.abort();
			await current;
			await rm(file, { force: true });
		},
	};
}
