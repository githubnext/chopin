/**
 * Configuration, read once at boot.
 *
 * Everything the process needs to know about its environment resolves here so
 * that a misconfiguration is a startup failure with a sentence attached rather
 * than a puzzling behaviour three screens later.
 */

import { join, resolve } from "node:path";

/**
 * The installation root.
 *
 * Derived from this file rather than the working directory, because the server
 * is usually started through a workspace filter and so runs with its own
 * package as the current directory — which is nobody's idea of where a room's
 * data belongs, or of what an agent should be reading.
 */
const ROOT = resolve(import.meta.dir, "../../..");

export type Config = {
	host: string;
	port: number;
	/** When set, required at the WebSocket upgrade. */
	key: string | undefined;
	/**
	 * What the agent is allowed to read.
	 *
	 * Defaults to the installation root and is printed at boot, because the
	 * extent of what an agent can read should never have to be guessed at.
	 */
	workingDir: string;
	/** Where room state is written. */
	dataDir: string;
	/** Planner model. */
	model: string;
	/**
	 * The agent's credential, and the bearer for the GitHub MCP server.
	 *
	 * Required in practice — the boot probe refuses to start without a working
	 * one — but held as optional here so the type does not claim a guarantee
	 * that configuration loading cannot make.
	 */
	token: string | undefined;
	/**
	 * Origin of a running Vite, when developing.
	 *
	 * Set, and everything that is not the socket is forwarded there; unset, and
	 * the built client is served from disk. This is deliberately explicit rather
	 * than sniffed from the presence of a `dist` directory, which lingers after
	 * a build and would make development quietly serve stale files.
	 */
	devClient: string | undefined;
};

const DEFAULT_PORT = 8787;
const DEFAULT_MODEL = "claude-sonnet-4.6";

function port(): number {
	let raw = process.env.PORT;
	if (!raw) return DEFAULT_PORT;
	let value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`PORT must be a number between 1 and 65535, got ${JSON.stringify(raw)}`);
	}
	return value;
}

export function load(): Config {
	return {
		host: process.env.SERVER_HOST || "127.0.0.1",
		port: port(),
		key: process.env.ACCESS_KEY || undefined,
		workingDir: resolve(process.env.WORKING_DIR || ROOT),
		dataDir: resolve(process.env.DATA_DIR || join(ROOT, "data")),
		model: process.env.MODEL || DEFAULT_MODEL,
		token: process.env.GITHUB_TOKEN || undefined,
		devClient: process.env.DEV_CLIENT || undefined,
	};
}

/**
 * What the operator needs to see before deciding to trust this process.
 *
 * The working directory is printed because it is the extent of what an agent
 * can read, and defaulting it to the current directory makes it too easy to
 * start one somewhere you did not intend.
 */
export function describe(config: Config): string {
	let parts = [
		"chopin",
		`http://${config.host}:${config.port}`,
		config.devClient ? `client: vite (${config.devClient})` : "client: built",
		`working dir: ${config.workingDir}`,
	];
	if (config.key) parts.push("access key: required");
	if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.key) {
		parts.push("WARNING: bound beyond localhost with no ACCESS_KEY");
	}
	return parts.join("  ·  ");
}
