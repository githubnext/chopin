/**
 * Configuration, read once at boot.
 *
 * Everything the process needs to know about its environment resolves here so
 * that a misconfiguration is a startup failure with a sentence attached rather
 * than a puzzling behaviour three screens later.
 */

import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { loadAuth } from "./auth/config";
import { setupAgents } from "./setup-agents";

import type { SetupAgent } from "@chopin/protocol/agents";
import type { AuthConfig } from "./auth/config";
import type { StorageConfig } from "./storage/registry";

export type Config = {
	host: string;
	port: number;
	/** Planner model. Empty under `HARNESS=remote` unless set, where the attached client chooses. */
	model: string;
	harness: string;
	harnessAuth: string | undefined;
	/**
	 * Extension or package paths every atomic Planner session loads, as if
	 * passed to the CLI's `--extension`. Split on the platform path delimiter.
	 */
	harnessExtensions: string[];
	/**
	 * Under `HARNESS=remote`, how long a detached or dropped Planner link keeps
	 * the document's Planner ownership for the same account to reattach.
	 */
	plannerAttachGraceMs: number;
	/** How often the server sends a Planner link a WebSocket protocol ping. */
	plannerLinkPingMs: number;
	/** How long a Planner link may go without a pong or message before it counts as dropped. */
	plannerLinkTimeoutMs: number;
	/**
	 * How long a Planner link may send nothing at all, however much of what the
	 * server queued for it drains meanwhile, before it counts as dropped.
	 */
	plannerLinkMaxSilenceMs: number;
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
	/** Explicitly enables the conversation-derived cards prototype. */
	conversationPlan?: boolean;
	conversationPlanModel?: string;
	conversationPlanTimeoutMs?: number;
	/** Explicitly enables Jev-routed foreground visual authoring. */
	plannerVisuals?: boolean;
	/** The chopin release `chopin update` installs from this server, and a refusal names. */
	connectorVersion?: string;
	/** Keep a finished build's document as the source for later rebuilds. */
	liveBuild?: boolean;
	/** CHOPIN_SETUP_AGENTS: setups the Machines page offers before the built-in agents. */
	setupAgents: SetupAgent[];
	/** Let the editor's local agent prototype uncertain passages before the first build. */
	liveSpikes?: boolean;
	/**
	 * LIVE_SPIKES_REGEX_JUDGE=on: without Jev, judge passages by explicit uncertainty words.
	 * Off by default, so a deployment without Jev starts no spikes.
	 */
	liveSpikesRegexJudge?: boolean;
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
const DEFAULT_ATTACH_GRACE_MS = 120_000;
export const DEFAULT_LINK_PING_MS = 15_000;
export const DEFAULT_LINK_TIMEOUT_MS = 120_000;
/**
 * Long enough for a client reading at about 19 KiB/s to drain the 16 MiB Bun lets the
 * server queue toward it and answer the next ping.
 */
export const DEFAULT_LINK_MAX_SILENCE_MS = 900_000;
const DEFAULT_MODEL = "gpt-6-luna";

/** The default is a Copilot model ID. Pi and Atomic resolve IDs against their
 * own catalogs, so those deployments must name a model rather than inherit one
 * the catalog lacks. A remote Planner's client brings its own model; a
 * configured one is only passed along as the turn's request. */
function model(harness: string): string {
	let configured = process.env.MODEL;
	if (configured) return configured;
	if (harness === "remote") return "";
	if (harness === "pi" || harness === "atomic") {
		throw new Error(`MODEL is required when HARNESS=${harness}`);
	}
	return DEFAULT_MODEL;
}
export function harnessSelection(): Pick<
	Config,
	"host" | "harness" | "harnessAuth" | "harnessExtensions"
> {
	return {
		host: process.env.SERVER_HOST || "127.0.0.1",
		harness: process.env.HARNESS || "copilot-sdk",
		harnessAuth: process.env.HARNESS_AUTH || undefined,
		harnessExtensions: (process.env.HARNESS_EXTENSIONS ?? "").split(delimiter).filter(Boolean),
	};
}

function port(): number {
	let raw = process.env.PORT;
	if (!raw) return DEFAULT_PORT;
	let value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`PORT must be a number between 1 and 65535, got ${JSON.stringify(raw)}`);
	}
	return value;
}

/** A Planner link liveness setting, in whole milliseconds from 1 second to `max`, 10 minutes by default. */
function milliseconds(name: string, fallback: number, max = 600_000): number {
	let raw = process.env[name];
	if (raw === undefined) return fallback;
	let value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1_000 || value > max) {
		throw new Error(`${name} must be an integer between 1000 and ${max} milliseconds`);
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

/**
 * CONNECTOR_VERSION, or the version of the connector built beside this server. A release tag's
 * `cli-v` or `v` prefix is dropped.
 */
function connectorVersion() {
	let raw = process.env.CONNECTOR_VERSION
		?? (JSON.parse(
			readFileSync(join(import.meta.dir, "../../connector/package.json"), "utf8"),
		) as { version: string }).version;
	let version = raw.replace(/^cli-/, "").replace(/^v/, "");
	if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("CONNECTOR_VERSION must be a chopin release version like 0.2.0");
	}
	return version;
}

export function load(): Config {
	let agent = process.env.AGENT !== "off";
	let backgroundJobs = process.env.BACKGROUND_JOBS !== "off";
	let conversationPlan = process.env.CONVERSATION_PLAN === "on";
	let plannerVisuals = process.env.PLANNER_VISUALS === "on" && agent;
	let liveBuild = process.env.LIVE_BUILD === "on";
	let liveSpikes = process.env.LIVE_SPIKES === "on";
	let liveSpikesRegexJudge = liveSpikes && process.env.LIVE_SPIKES_REGEX_JUDGE === "on";
	let conversationPlanModel = process.env.JEV_MODEL || "jev-latest";
	let timeoutRaw = process.env.JEV_TIMEOUT_MS;
	let conversationPlanTimeoutMs = timeoutRaw === undefined ? 30_000 : Number(timeoutRaw);
	if (
		(timeoutRaw !== undefined && !/^\d+$/.test(timeoutRaw))
		|| !Number.isSafeInteger(conversationPlanTimeoutMs)
		|| conversationPlanTimeoutMs < 100 || conversationPlanTimeoutMs > 60_000
	) {
		throw new Error("JEV_TIMEOUT_MS must be an integer between 100 and 60000 milliseconds");
	}
	if (conversationPlan && !process.env.JEV_API_KEY) {
		throw new Error("JEV_API_KEY is required when CONVERSATION_PLAN=on");
	}
	if (plannerVisuals && !process.env.JEV_API_KEY) {
		throw new Error("JEV_API_KEY is required when PLANNER_VISUALS=on");
	}
	if (
		(conversationPlan || plannerVisuals) && !/^[A-Za-z0-9._-]{1,100}$/.test(conversationPlanModel)
	) {
		throw new Error("JEV_MODEL must be a valid model alias");
	}
	let graceRaw = process.env.PLANNER_ATTACH_GRACE_MS;
	let plannerAttachGraceMs = graceRaw === undefined ? DEFAULT_ATTACH_GRACE_MS : Number(graceRaw);
	if (
		(graceRaw !== undefined && !/^\d+$/.test(graceRaw))
		|| !Number.isSafeInteger(plannerAttachGraceMs) || plannerAttachGraceMs > 3_600_000
	) {
		throw new Error(
			"PLANNER_ATTACH_GRACE_MS must be an integer between 0 and 3600000 milliseconds",
		);
	}
	let plannerLinkPingMs = milliseconds("PLANNER_LINK_PING_MS", DEFAULT_LINK_PING_MS);
	let plannerLinkTimeoutMs = milliseconds("PLANNER_LINK_TIMEOUT_MS", DEFAULT_LINK_TIMEOUT_MS);
	if (plannerLinkTimeoutMs <= plannerLinkPingMs) {
		throw new Error("PLANNER_LINK_TIMEOUT_MS must be longer than PLANNER_LINK_PING_MS");
	}
	let plannerLinkMaxSilenceMs = milliseconds(
		"PLANNER_LINK_MAX_SILENCE_MS",
		DEFAULT_LINK_MAX_SILENCE_MS,
		3_600_000,
	);
	if (plannerLinkMaxSilenceMs < plannerLinkTimeoutMs) {
		throw new Error("PLANNER_LINK_MAX_SILENCE_MS must be at least PLANNER_LINK_TIMEOUT_MS");
	}
	let selection = harnessSelection();
	if (selection.harness === "remote" && backgroundJobs) {
		throw new Error(
			"HARNESS=remote requires BACKGROUND_JOBS=off: summary and research workers have no model on the server",
		);
	}
	let serverPort = port();
	return {
		...selection,
		port: serverPort,
		model: model(selection.harness),
		plannerAttachGraceMs,
		plannerLinkPingMs,
		plannerLinkTimeoutMs,
		plannerLinkMaxSilenceMs,
		agent,
		backgroundJobs,
		webResearch: agent && backgroundJobs && process.env.WEB_RESEARCH !== "off",
		conversationPlan,
		conversationPlanModel,
		conversationPlanTimeoutMs,
		plannerVisuals,
		connectorVersion: connectorVersion(),
		liveBuild,
		setupAgents: setupAgents(process.env.CHOPIN_SETUP_AGENTS),
		liveSpikes,
		liveSpikesRegexJudge,
		devClient: process.env.DEV_CLIENT || undefined,
		storage: storage(),
		auth: loadAuth(serverPort, selection.host),
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
		? `auth: github${
			config.auth.local ? " local device flow" : ""
		} (restricted: ${users} users, ${organizations} organizations)`
		: `auth: github${config.auth.local ? " local device flow" : ""} (unrestricted)`;
	let parts = [
		"chopin",
		`http://${config.host}:${config.port}`,
		config.devClient ? `client: vite (${config.devClient})` : "client: built",
		config.agent
			? `agent: ${config.model || "chosen by the attached client"} (on demand)`
			: "agent: off",
		`harness: ${config.harness}`,
		...(config.harness === "atomic"
			? ["Planner: full Atomic session (shell and filesystem access as this process's user)"]
			: []),
		...(config.harness === "remote"
			? ["Planner: attached client over /planner-link (model and client tools run on its machine)"]
			: []),
		...(config.harnessExtensions.length
			? [`Planner extensions: ${config.harnessExtensions.join(", ")}`]
			: []),
		config.backgroundJobs ? "background jobs: on" : "background jobs: off",
		config.webResearch ? "web research: on" : "web research: off",
		config.conversationPlan
			? `conversation plan: ${config.conversationPlanModel}`
			: "conversation plan: off",
		config.plannerVisuals
			? `Planner visuals: ${config.conversationPlanModel}`
			: "Planner visuals: off",
		config.liveBuild ? "live build: on" : "live build: off",
		config.liveSpikes ? "live spikes: on" : "live spikes: off",
		admission,
		`storage: ${config.storage.driver}`,
	];
	return parts.join("  ·  ");
}
