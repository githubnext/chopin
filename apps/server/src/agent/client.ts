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
import { NAME, planner } from "./planner";

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
		logLevel: "warning",
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
			return { agent: { session, id: previous }, resumed: true };
		} catch {
			// The session is gone — a cleared ~/.copilot, a CLI upgrade, an
			// expired store. The caller says so rather than letting the
			// transcript imply a memory the agent no longer has.
		}
	}

	let session = await started.createSession(settings);
	await session.rpc.agent.select({ name: NAME });
	return { agent: { session, id: session.sessionId }, resumed: false };
}

/** Let go of the CLI process. Sessions are the caller's to close first. */
export async function shutdown(): Promise<void> {
	await client?.stop().catch(() => {});
	client = undefined;
}
