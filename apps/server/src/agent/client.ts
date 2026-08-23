/**
 * Starting the agent.
 *
 * Disposable Planner and worker sessions share one hardened runtime. A
 * restarted process reconstructs context from durable Chopin state rather
 * than resuming Copilot's filesystem state.
 */

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locate } from "./cli";
import {
	gate,
	PUBLIC_WEB_SEARCH_FILTER,
	PUBLIC_WEB_SEARCH_SERVER,
	PUBLIC_WEB_SEARCH_TOOL,
	publicResearchGate,
	terminalGate,
} from "./permissions";
import { NAME, plannerFor, TOOLS } from "./planner";
import { Runtime } from "./runtime";

import type {
	CopilotSession,
	CurrentToolMetadata,
	CustomAgentConfig,
	SessionConfig,
	Tool,
} from "@github/copilot-sdk";
import type { Config } from "../config";
import type { HostedRepository } from "./repository";

export type Agent = {
	session: CopilotSession;
	/** Runtime identity used only to delete the disposable SDK session. */
	id: string;
};

/** The tools a planner may call, over and above the runtime's own. */
export type Toolbox = { tools: Tool[] };

export type PlannerSession = {
	token: string;
	repository: HostedRepository;
	bootstrap?: string;
	authorize?: () => Promise<boolean>;
};

export type WorkerSession = {
	token: string;
	name: string;
	prompt: string;
	result: Tool;
	maxAiCredits: number;
	authorize?: () => Promise<boolean>;
	onWebSearchDenied?: () => void;
};

const SESSION_CONTROL_TIMEOUT_MS = 10_000;
const MIN_WORKER_AI_CREDITS = 30;
const MCP_READY_TIMEOUT_MS = 20_000;
const MCP_READY_POLL_MS = 100;
export const RUNTIME_ENV = {
	COPILOT_ENABLE_BUILTIN_GITHUB_MCP: "true",
	COPILOT_PLUGIN_DIR_ONLY: "true",
} as const;

type WorkerToolSession = {
	rpc: {
		tools: Pick<
			CopilotSession["rpc"]["tools"],
			"getCurrentMetadata" | "initializeAndValidate"
		>;
		mcp: Pick<CopilotSession["rpc"]["mcp"], "list" | "listTools">;
	};
};

function bounded<T>(
	operation: Promise<T>,
	message: string,
	timeoutMs = SESSION_CONTROL_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		operation.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			err => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

function workerCreditLimit(value: number): number {
	if (!Number.isFinite(value) || value < MIN_WORKER_AI_CREDITS) {
		throw new Error(`Background worker maxAiCredits must be at least ${MIN_WORKER_AI_CREDITS}.`);
	}
	return value;
}

function hardened(config: Pick<Config, "model">, token: string): SessionConfig {
	return {
		model: config.model,
		largeOutput: { enabled: false },
		gitHubToken: token,
		enableConfigDiscovery: false,
		skipCustomInstructions: true,
		enableOnDemandInstructionDiscovery: false,
		enableFileHooks: false,
		enableHostGitOperations: false,
		enableSessionStore: false,
		enableSkills: false,
		skillDirectories: [],
		pluginDirectories: [],
		infiniteSessions: { enabled: false },
		skipEmbeddingRetrieval: true,
		embeddingCacheStorage: "in-memory",
		mcpOAuthTokenStorage: "in-memory",
		enableSessionTelemetry: false,
		remoteSession: "off",
	} as SessionConfig;
}

export function plannerConfiguration(
	config: Pick<Config, "model">,
	toolbox: Toolbox,
	options: PlannerSession,
): SessionConfig {
	let repository = `${options.repository.owner}/${options.repository.name}`;
	let tools = toolbox.tools.map(tool => ({ ...tool, skipPermission: false }));
	return {
		...hardened(config, options.token),
		streaming: true,
		availableTools: TOOLS,
		tools,
		customAgents: [plannerFor(repository)],
		agent: NAME,
		mcpServers: {
			github: {
				type: "http",
				url: "https://api.githubcopilot.com/mcp/",
				tools: ["*"],
				headers: {
					Authorization: `Bearer ${options.token}`,
					"X-MCP-Readonly": "true",
					"X-MCP-Toolsets": "pull_requests",
				},
			},
		},
		systemMessage: {
			mode: "append",
			content: [
				`The selected repository is ${repository}. Repository reads must remain inside it.`,
				"More than one person may be in this conversation; their messages are prefixed with the speaker's handle.",
				options.bootstrap ?? "",
			].filter(Boolean).join(" "),
		},
		onPermissionRequest: gate({
			owner: options.repository.owner,
			repository: options.repository.name,
			tools: new Set(tools.map(tool => tool.name)),
			active: options.authorize,
		}),
	} as SessionConfig;
}

export function workerConfiguration(
	config: Pick<Config, "model">,
	options: WorkerSession,
): SessionConfig {
	let result = { ...options.result, skipPermission: false, isTerminal: true };
	let worker: CustomAgentConfig = {
		name: options.name,
		displayName: "Background worker",
		description: "Executes one registered background job and submits its structured result.",
		prompt: options.prompt,
		infer: false,
	};
	return {
		...hardened(config, options.token),
		streaming: false,
		sessionLimits: { maxAiCredits: workerCreditLimit(options.maxAiCredits) },
		availableTools: [`custom:${result.name}`],
		tools: [result],
		customAgents: [worker],
		agent: worker.name,
		mcpServers: {},
		onPermissionRequest: terminalGate(result.name, options.authorize),
	} as SessionConfig;
}

export function publicResearchConfiguration(
	config: Pick<Config, "model">,
	options: WorkerSession,
): SessionConfig {
	let result = { ...options.result, skipPermission: false, isTerminal: true };
	let worker: CustomAgentConfig = {
		name: options.name,
		displayName: "Public research worker",
		description: "Researches public web evidence without private Chopin or repository context.",
		prompt: options.prompt,
		infer: false,
	};
	return {
		...hardened(config, options.token),
		enableConfigDiscovery: true,
		streaming: false,
		sessionLimits: { maxAiCredits: workerCreditLimit(options.maxAiCredits) },
		availableTools: [
			`custom:${result.name}`,
			PUBLIC_WEB_SEARCH_FILTER,
		],
		tools: [result],
		customAgents: [worker],
		agent: worker.name,
		githubMcpToolConfig: { additionalTools: [PUBLIC_WEB_SEARCH_TOOL] },
		mcpServers: {},
		enableCitations: true,
		onPermissionRequest: publicResearchGate(
			result.name,
			options.authorize,
			options.onWebSearchDenied,
		),
	} as SessionConfig;
}

function connect() {
	let cli = locate();
	if (!cli.ok) throw new Error(cli.reason);
	let home = mkdtempSync(join(tmpdir(), "chopin-copilot-"));
	try {
		let client = new CopilotClient({
			mode: "empty",
			workingDirectory: home,
			baseDirectory: home,
			connection: RuntimeConnection.forStdio({ path: cli.path }),
			useLoggedInUser: false,
			// Only the public worker enables discovery, inside this empty temporary home.
			env: RUNTIME_ENV,
			logLevel: "info",
		});
		return { client, cleanup: () => rmSync(home, { recursive: true, force: true }) };
	} catch (err) {
		rmSync(home, { recursive: true, force: true });
		throw err;
	}
}

let runtime = new Runtime(connect);

/**
 * Report what the planner can actually call.
 *
 * A tool filter is matched against names by the runtime, and an entry that
 * matches nothing is dropped without a word. There is no other place that
 * truth is visible: the agent simply behaves as though it never had the tool,
 * and explains its way around the absence rather than reporting it — which is
 * how a planner can spend a turn apologising for having no GitHub access while
 * its prompt insists it has.
 *
 * Runs against a real session rather than the boot probe, because the probe
 * has no room and therefore none of the plan tools; auditing it would report a
 * set nobody ever gets. Costs one line per session, and is never fatal — a
 * diagnostic that can stop a turn is worse than no diagnostic.
 */
async function audit(session: CopilotSession): Promise<void> {
	try {
		await session.rpc.tools.initializeAndValidate();
		let { tools } = await session.rpc.tools.getCurrentMetadata();

		if (!tools) {
			console.warn("[agent] the tool list is not initialised");
		} else {
			let names = tools.map(tool => tool.namespacedName || tool.name).sort();
			console.log(`[agent] ${names.length} tools: ${names.join(", ")}`);
		}
	} catch (err) {
		console.warn("[agent] could not read the tool list:", err);
	}

	try {
		// Throws when the server never connected, which is the distinction
		// worth having: no tools because none were offered, or no tools
		// because the ones offered were not matched.
		let { tools } = await session.rpc.mcp.listTools({ serverName: "github" });
		console.log(`[agent] github mcp: ${tools.length} tools offered`);
	} catch (err) {
		let reason = err instanceof Error ? err.message : String(err);
		console.warn(`[agent] github mcp is not connected: ${reason}`);
	}
}

export function assertWorkerTools(
	tools: CurrentToolMetadata[] | null | undefined,
	expected: string,
	publicWeb = false,
): void {
	let values = tools ?? [];
	let result = values.filter(tool =>
		tool.name === expected
		&& !tool.mcpServerName
		&& !tool.mcpToolName
		&& (!tool.namespacedName || tool.namespacedName === `custom:${expected}`)
	);
	let web = values.filter(tool =>
		tool.mcpServerName === PUBLIC_WEB_SEARCH_SERVER
		&& tool.mcpToolName === PUBLIC_WEB_SEARCH_TOOL
	);
	let matches = values.length === (publicWeb ? 2 : 1)
		&& result.length === 1
		&& web.length === (publicWeb ? 1 : 0);
	if (!matches) {
		let wanted = [`custom:${expected}`, ...(publicWeb ? [PUBLIC_WEB_SEARCH_FILTER] : [])];
		let received = values.map(tool =>
			tool.namespacedName
				?? (tool.mcpServerName || tool.mcpToolName
					? `mcp:${tool.mcpServerName ?? "unknown"}-${tool.mcpToolName ?? tool.name}`
					: `local:${tool.name}`)
		).sort();
		throw new Error(
			`Background worker capability audit failed: expected ${wanted.join(", ")}, received ${
				received.length > 0 ? received.join(", ") : "none"
			}.`,
		);
	}
}

async function auditWorker(session: CopilotSession, expected: string): Promise<void> {
	await session.rpc.tools.initializeAndValidate();
	let { tools } = await session.rpc.tools.getCurrentMetadata();
	assertWorkerTools(tools, expected);
}

export async function auditPublicResearchTools(
	session: WorkerToolSession,
	expected: string,
	options: {
		timeoutMs?: number;
		pollMs?: number;
		now?: () => number;
		wait?: (ms: number) => Promise<void>;
	} = {},
): Promise<void> {
	let timeoutMs = options.timeoutMs ?? MCP_READY_TIMEOUT_MS;
	let pollMs = options.pollMs ?? MCP_READY_POLL_MS;
	let now = options.now ?? (() => performance.now());
	let wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	let deadline = now() + timeoutMs;
	let within = async <T>(operation: () => Promise<T>): Promise<T> => {
		let remaining = deadline - now();
		let message = "Background worker MCP readiness timed out.";
		if (remaining <= 0) throw new Error(message);
		let result = await bounded(operation(), message, remaining);
		if (now() >= deadline) throw new Error(message);
		return result;
	};
	await within(() => session.rpc.tools.initializeAndValidate());
	while (true) {
		let current = await within(() => session.rpc.mcp.list());
		let server = current.servers.find(value => value.name === PUBLIC_WEB_SEARCH_SERVER);
		if (server?.status === "connected") break;
		let pending = server?.status === "pending"
			|| current.host?.pendingConnections.includes(PUBLIC_WEB_SEARCH_SERVER);
		if (!pending) {
			let status = server?.status ?? "not_configured";
			throw new Error(
				`Background worker MCP server ${PUBLIC_WEB_SEARCH_SERVER} is ${status}${
					server?.error ? `: ${server.error}` : ""
				}.`,
			);
		}
		let remaining = deadline - now();
		if (remaining <= 0) {
			throw new Error(`Background worker MCP server ${PUBLIC_WEB_SEARCH_SERVER} timed out.`);
		}
		await within(() => wait(Math.min(pollMs, remaining)));
	}
	let offered = await within(() =>
		session.rpc.mcp.listTools({ serverName: PUBLIC_WEB_SEARCH_SERVER })
	);
	let offeredNames = offered.tools.map(tool => tool.name).sort();
	if (!offeredNames.includes(PUBLIC_WEB_SEARCH_TOOL)) {
		throw new Error(
			`Background worker MCP server ${PUBLIC_WEB_SEARCH_SERVER} does not offer ${PUBLIC_WEB_SEARCH_TOOL}; offered ${
				offeredNames.length > 0 ? offeredNames.join(", ") : "none"
			}.`,
		);
	}
	await within(() => session.rpc.tools.initializeAndValidate());
	let { tools } = await within(() => session.rpc.tools.getCurrentMetadata());
	assertWorkerTools(tools, expected, true);
}

/** Create a disposable session authenticated and scoped to one owner and repository. */
export async function openPlanner(
	config: Pick<Config, "agent" | "model">,
	toolbox: Toolbox,
	options: PlannerSession,
): Promise<Agent> {
	if (!config.agent) throw new Error("The hosted agent is disabled.");
	let session = await runtime.open(plannerConfiguration(config, toolbox, options));
	try {
		await session.rpc.agent.select({ name: NAME });
		await audit(session);
		return { session, id: session.sessionId };
	} catch (err) {
		await runtime.discard(session).catch(() => {});
		throw err;
	}
}

/** Create a disposable isolated session for one registered background attempt. */
export async function openWorker(
	config: Pick<Config, "agent" | "model">,
	options: WorkerSession,
): Promise<Agent> {
	if (!config.agent) throw new Error("The hosted agent is disabled.");
	let session = await runtime.open(workerConfiguration(config, options));
	try {
		await session.rpc.agent.select({ name: options.name });
		await auditWorker(session, options.result.name);
		return { session, id: session.sessionId };
	} catch (err) {
		await runtime.discard(session).catch(() => {});
		throw err;
	}
}

/** Create a public-web worker with no private document or repository capabilities. */
export async function openPublicResearchWorker(
	config: Pick<Config, "agent" | "model">,
	options: WorkerSession,
): Promise<Agent> {
	if (!config.agent) throw new Error("The hosted agent is disabled.");
	let session = await runtime.open(publicResearchConfiguration(config, options));
	try {
		await session.rpc.agent.select({ name: options.name });
		await auditPublicResearchTools(session, options.result.name);
		return { session, id: session.sessionId };
	} catch (err) {
		await runtime.discard(session).catch(() => {});
		throw err;
	}
}

export async function discard(agent: Agent): Promise<void> {
	let owned: boolean;
	try {
		owned = await runtime.discard(agent.session);
	} catch {
		return;
	}
	if (!owned) await agent.session.disconnect().catch(() => {});
}

/** Bound an SDK abort so runtime shutdown can still force a wedged session down. */
export async function abort(agent: Agent): Promise<void> {
	await bounded(
		Promise.resolve().then(() => agent.session.abort()),
		`Copilot session ${agent.id} abort timed out.`,
	).catch(() => {});
}

/** Stop waiting for an opening session, and dispose it if it arrives later. */
export async function settle(opening: Promise<Agent>): Promise<Agent | undefined> {
	let expired = false;
	let watched = opening.then(agent => {
		if (expired) void discard(agent);
		return agent;
	}, () => undefined);
	let opened = await bounded(watched, "Copilot session opening timed out.").catch(() => undefined);
	expired = true;
	return opened;
}

/** Close every remaining session and let go of the CLI process. */
export async function shutdown(): Promise<void> {
	await runtime.shutdown();
}
