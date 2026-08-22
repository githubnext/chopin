/**
 * Configuration, read once at boot.
 *
 * Everything the process needs to know about its environment resolves here so
 * that a misconfiguration is a startup failure with a sentence attached rather
 * than a puzzling behaviour three screens later.
 */

import { loadAuth } from "./auth/config";

import type { AuthConfig } from "./auth/config";
import type { StorageConfig } from "./storage/registry";

export type Config = {
	host: string;
	port: number;
	/** Planner model. */
	model: string;
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
	backgroundJobs: boolean;
	webResearch: boolean;
	/**
	 * Origin of a running Vite, when developing.
	 *
	 * Set, and everything that is not the socket is forwarded there; unset, and
	 * the built client is served from disk. This is deliberately explicit rather
	 * than sniffed from the presence of a `dist` directory, which lingers after
	 * a build and would make development quietly serve stale files.
	 */
	devClient: string | undefined;
	/** Durable service storage. */
	storage: StorageConfig;
	/** GitHub identity and short-lived OAuth attempt encryption. */
	auth: AuthConfig;
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
	let driver = process.env.STORAGE_DRIVER || "postgres";
	if (driver !== "postgres") {
		throw new Error(`STORAGE_DRIVER must be "postgres", got ${JSON.stringify(driver)}`);
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
	let agent = process.env.AGENT !== "off";
	let backgroundJobs = process.env.BACKGROUND_JOBS !== "off";
	return {
		host: process.env.SERVER_HOST || "127.0.0.1",
		port: port(),
		model: process.env.MODEL || DEFAULT_MODEL,
		agent,
		backgroundJobs,
		webResearch: agent && backgroundJobs && process.env.WEB_RESEARCH !== "off",
		devClient: process.env.DEV_CLIENT || undefined,
		storage: storage(),
		auth: loadAuth(),
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
	let users = config.auth.allowedUsers?.size ?? 0;
	let organizations = config.auth.allowedOrganizations?.size ?? 0;
	let admission = users || organizations
		? `auth: github (restricted: ${users} users, ${organizations} organizations)`
		: "auth: github (unrestricted)";
	let parts = [
		"chopin",
		`http://${config.host}:${config.port}`,
		config.devClient ? `client: vite (${config.devClient})` : "client: built",
		config.agent ? `agent: ${config.model} (on demand)` : "agent: off",
		config.backgroundJobs ? "background jobs: on" : "background jobs: off",
		config.webResearch ? "web research: on" : "web research: off",
		admission,
		`storage: ${config.storage.driver}`,
	];
	return parts.join("  ·  ");
}
