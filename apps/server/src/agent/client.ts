/**
 * Starting the agent.
 *
 * One session per room, created on the first prompt and resumed by id after an
 * idle teardown or a restart. Rooms do not share a session: a conversation is
 * about one plan, and mixing two would leak the contents of one room into
 * another's context.
 *
 * Everything that can fail at boot is made to fail at boot. A missing binary,
 * an absent token and a token Copilot will not accept are all discovered by
 * starting a session and throwing it away, rather than by the first person to
 * type something being told the agent is broken.
 */

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

import { locate } from "./cli";
import { gate } from "./permissions";
import { NAME, planner, TOOLS } from "./planner";

import type { CopilotSession, SessionConfig, Tool } from "@github/copilot-sdk";
import type { Config } from "../config";

export type Agent = {
	session: CopilotSession;
	/** Persisted so the conversation survives an idle teardown or a restart. */
	id: string;
};

/** The tools a planner may call, over and above the runtime's own. */
export type Toolbox = { tools: Tool[] };

function configure(config: Config, toolbox: Toolbox): SessionConfig {
	return {
		model: config.model,
		streaming: true,
		// Discovery would let the working directory reconfigure the session that
		// is planning for it.
		enableConfigDiscovery: false,
		customAgents: [planner],
		enableSkills: true,
		skillDirectories: [`${config.workingDir}/.agents/skills`],
		tools: toolbox.tools,
		// The real allowlist. See `TOOLS` for why it cannot live on the agent.
		availableTools: TOOLS,
		mcpServers: config.token
			? {
				github: {
					type: "http",
					url: "https://api.githubcopilot.com/mcp/",
					tools: ["*"],
					headers: {
						Authorization: `Bearer ${config.token}`,
						// Belt and braces: the gate refuses a write anyway, but the
						// server should not offer one in the first place.
						"X-MCP-Readonly": "true",
					},
				},
			}
			: {},
		infiniteSessions: { enabled: true },
		systemMessage: {
			mode: "append",
			content: [
				`The working directory is ${config.workingDir}. It is the only thing you can read.`,
				"More than one person may be in this conversation; their messages are prefixed",
				"with the speaker's handle.",
			].join(" "),
		},
		onPermissionRequest: gate({
			root: config.workingDir,
			tools: new Set(toolbox.tools.map(tool => tool.name)),
		}),
	} as SessionConfig;
}

let client: CopilotClient | undefined;

function connect(config: Config): CopilotClient {
	if (client) return client;

	let cli = locate();
	if (!cli.ok) throw new Error(cli.reason);

	return client = new CopilotClient({
		workingDirectory: config.workingDir,
		// Pointed at the pinned native binary. Left to itself the SDK resolves
		// the bundled JavaScript and spawns `node`, which under Bun is a literal
		// string that may not resolve to anything.
		connection: RuntimeConnection.forStdio({ path: cli.path }),
		// The CLI's own warnings reach our stderr as `[CLI subprocess]` lines, and
		// a server that fails to connect says so there and nowhere else.
		logLevel: "info",
		gitHubToken: config.token,
	});
}

/**
 * Prove the agent can run, then throw the proof away.
 *
 * Costs a couple of seconds and one process at startup, and buys the
 * difference between a server that refuses to start with a reason and one that
 * looks healthy until somebody tries to use it. A stale token is by far the
 * most likely failure and is only detectable by asking.
 */
export async function probe(config: Config, toolbox: Toolbox): Promise<void> {
	let started = connect(config);
	await started.start();

	let session = await started.createSession(configure(config, toolbox));
	try {
		// Selecting the agent is the cheapest thing that proves the whole chain:
		// the binary ran, the token was accepted, and the runtime answered.
		await session.rpc.agent.select({ name: NAME });
	} finally {
		await session.disconnect().catch(() => {});
	}
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
async function audit(session: CopilotSession, config: Config): Promise<void> {
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

	if (!config.token) return;

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

/** Open a room's session, resuming the conversation when there is one. */
export async function open(
	config: Config,
	toolbox: Toolbox,
	previous?: string,
): Promise<{ agent: Agent; resumed: boolean }> {
	let started = connect(config);
	await started.start();

	let settings = configure(config, toolbox);

	if (previous) {
		try {
			let session = await started.resumeSession(previous, settings);
			await session.rpc.agent.select({ name: NAME });
			await audit(session, config);
			return { agent: { session, id: previous }, resumed: true };
		} catch {
			// The session is gone — a cleared ~/.copilot, a CLI upgrade, an
			// expired store. The caller says so rather than letting the
			// transcript imply a memory the agent no longer has.
		}
	}

	let session = await started.createSession(settings);
	await session.rpc.agent.select({ name: NAME });
	await audit(session, config);
	return { agent: { session, id: session.sessionId }, resumed: false };
}

/** Let go of the CLI process. Sessions are the caller's to close first. */
export async function shutdown(): Promise<void> {
	await client?.stop().catch(() => {});
	client = undefined;
}
