/**
 * Configuration, read once at boot.
 *
 * Everything the process needs to know about its environment resolves here so
 * that a misconfiguration is a startup failure with a sentence attached rather
 * than a puzzling behaviour three screens later.
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { StorageConfig } from "./storage/registry";

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
	 *
	 * A relative value is resolved against the current directory, which is the
	 * one you typed the command in — the development supervisor resolves it
	 * before handing it on, since it starts the server somewhere else.
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
	 * Whether to run the agent at all.
	 *
	 * Off is a deliberate choice, not a fallback: the server still refuses to
	 * start with a broken agent, because the failure worth catching is a
	 * misconfigured one. Saying `AGENT=off` is saying you know. Used by tests,
	 * which have no business spawning a language model, and by anyone who
	 * wants the editor on its own.
	 */
	agent: boolean;
	/**
	 * Origin of a running Vite, when developing.
	 *
	 * Set, and everything that is not the socket is forwarded there; unset, and
	 * the built client is served from disk. This is deliberately explicit rather
	 * than sniffed from the presence of a `dist` directory, which lingers after
	 * a build and would make development quietly serve stale files.
	 */
	devClient: string | undefined;
	/** Durable service storage; legacy keeps the prototype room files during cutover. */
	storage: StorageConfig;
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

function storage(): StorageConfig {
	let driver = process.env.STORAGE_DRIVER || "legacy";
	if (driver === "legacy") return { driver };
	if (driver !== "postgres") {
		throw new Error(`STORAGE_DRIVER must be "legacy" or "postgres", got ${JSON.stringify(driver)}`);
	}

	let raw = process.env.DATABASE_URL;
	if (!raw) throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
	try {
		let url = new URL(raw);
		if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
	} catch {
		throw new Error("DATABASE_URL must be a PostgreSQL URL");
	}
	return { driver, url: raw };
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
		agent: process.env.AGENT !== "off",
		devClient: process.env.DEV_CLIENT || undefined,
		storage: storage(),
	};
}

/**
 * What is wrong with this configuration, if anything.
 *
 * A working directory that is not there is worth catching here rather than
 * three layers down. The CLI is spawned with it as its own working directory,
 * so a bad path kills that process the instant it starts, and what surfaces is
 * the SDK failing to write to a stream that is already gone — a message with
 * nothing in it about paths.
 */
export function problem(config: Config): string | undefined {
	let target = statSync(config.workingDir, { throwIfNoEntry: false });

	if (!target) {
		return `WORKING_DIR does not exist: ${config.workingDir}`;
	}
	if (!target.isDirectory()) {
		return `WORKING_DIR is not a directory: ${config.workingDir}`;
	}
	return undefined;
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
		config.agent ? `agent: ${config.model}` : "agent: off",
		`storage: ${config.storage.driver}`,
		`working dir: ${config.workingDir}`,
	];
	if (config.key) parts.push("access key: required");
	if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.key) {
		parts.push("WARNING: bound beyond localhost with no ACCESS_KEY");
	}
	return parts.join("  ·  ");
}
