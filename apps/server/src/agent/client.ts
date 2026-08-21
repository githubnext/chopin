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
import { gate, publicResearchGate, terminalGate } from "./permissions";
import { NAME, plannerFor, TOOLS } from "./planner";
import { Runtime } from "./runtime";

import type { CopilotSession, CustomAgentConfig, SessionConfig, Tool } from "@github/copilot-sdk";
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
};

const SESSION_CONTROL_TIMEOUT_MS = 10_000;

function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(message)), SESSION_CONTROL_TIMEOUT_MS);
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
	if (!Number.isFinite(options.maxAiCredits) || options.maxAiCredits <= 0) {
		throw new Error("Background worker maxAiCredits must be finite and positive.");
	}
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
		sessionLimits: { maxAiCredits: options.maxAiCredits },
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
	if (!Number.isFinite(options.maxAiCredits) || options.maxAiCredits <= 0) {
		throw new Error("Background worker maxAiCredits must be finite and positive.");
	}
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
		streaming: false,
		sessionLimits: { maxAiCredits: options.maxAiCredits },
		availableTools: [
			`custom:${result.name}`,
			"mcp:github-web_search",
		],
		tools: [result],
		customAgents: [worker],
		agent: worker.name,
		mcpServers: {
			github: {
				type: "http",
				url: "https://api.githubcopilot.com/mcp/",
				tools: ["web_search"],
				headers: {
					Authorization: `Bearer ${options.token}`,
					"X-MCP-Readonly": "true",
					"X-MCP-Tools": "web_search",
				},
			},
		},
		onPermissionRequest: publicResearchGate(result.name, options.authorize),
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
			env: {},
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

export function assertWorkerTools(names: string[], expected: string | string[]): void {
	let wanted = (typeof expected === "string" ? [`custom:${expected}`] : expected).toSorted();
	let matches = names.length === wanted.length
		&& names.every((name, index) => name === wanted[index]);
	if (!matches) {
		throw new Error(
			`Background worker capability audit failed: expected ${wanted.join(", ")}, received ${
				names.length > 0 ? names.join(", ") : "none"
			}.`,
		);
	}
}

async function auditWorker(session: CopilotSession, expected: string): Promise<void> {
	await session.rpc.tools.initializeAndValidate();
	let { tools } = await session.rpc.tools.getCurrentMetadata();
	let names = tools?.map(tool => tool.namespacedName || `unqualified:${tool.name}`).sort() ?? [];
	assertWorkerTools(names, expected);
}

async function auditPublicResearchWorker(session: CopilotSession, expected: string): Promise<void> {
	await session.rpc.tools.initializeAndValidate();
	let { tools } = await session.rpc.tools.getCurrentMetadata();
	let names = tools?.map(tool => tool.namespacedName || `unqualified:${tool.name}`).sort() ?? [];
	assertWorkerTools(names, [
		`custom:${expected}`,
		"mcp:github-web_search",
	]);
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
		await auditPublicResearchWorker(session, options.result.name);
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
