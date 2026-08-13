/**
 * Starting the agent.
 *
 * One disposable session per active channel, authenticated by its first
 * invoking editor. A restarted process reconstructs context from durable
 * Chopin state rather than resuming Copilot's filesystem state.
 */

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locate } from "./cli";
import { gate } from "./permissions";
import { NAME, plannerFor, TOOLS } from "./planner";

import type { CopilotSession, SessionConfig, Tool } from "@github/copilot-sdk";
import type { Config } from "../config";
import type { HostedRepository } from "./repository";

export type Agent = {
	session: CopilotSession;
	/** Runtime identity used only to delete the disposable SDK session. */
	id: string;
};

/** The tools a planner may call, over and above the runtime's own. */
export type Toolbox = { tools: Tool[] };

export type RepositorySession = {
	token: string;
	repository: HostedRepository;
	bootstrap?: string;
	authorize?: () => Promise<boolean>;
};

export function configuration(
	config: Pick<Config, "model">,
	toolbox: Toolbox,
	options: RepositorySession,
): SessionConfig {
	let repository = `${options.repository.owner}/${options.repository.name}`;
	let tools = toolbox.tools.map(tool => ({ ...tool, skipPermission: false }));
	return {
		model: config.model,
		streaming: true,
		largeOutput: { enabled: false },
		gitHubToken: options.token,
		availableTools: TOOLS,
		tools,
		customAgents: [plannerFor(repository)],
		agent: NAME,
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

let client: CopilotClient | undefined;
let home: string | undefined;

function connect(): CopilotClient {
	if (client) return client;
	let cli = locate();
	if (!cli.ok) throw new Error(cli.reason);
	home = mkdtempSync(join(tmpdir(), "chopin-copilot-"));
	return client = new CopilotClient({
		mode: "empty",
		workingDirectory: home,
		baseDirectory: home,
		connection: RuntimeConnection.forStdio({ path: cli.path }),
		useLoggedInUser: false,
		env: {},
		logLevel: "info",
	});
}

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

/** Create a disposable session authenticated and scoped to one owner and repository. */
export async function open(
	config: Pick<Config, "model">,
	toolbox: Toolbox,
	options: RepositorySession,
): Promise<Agent> {
	let started = connect();
	await started.start();
	let session = await started.createSession(configuration(config, toolbox, options));
	await session.rpc.agent.select({ name: NAME });
	await audit(session);
	return { session, id: session.sessionId };
}

export async function discard(agent: Agent): Promise<void> {
	await agent.session.disconnect().catch(() => {});
	await client?.deleteSession(agent.id).catch(() => {});
}

/** Let go of the CLI process. Sessions are the caller's to close first. */
export async function shutdown(): Promise<void> {
	await client?.stop().catch(() => {});
	client = undefined;
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
}
