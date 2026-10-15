/**
 * The coding agents the Machines page and the setup guide offer for `chopin connect`, which also
 * names one's install and sign-in commands when its program is missing. Each is checked against
 * its own documentation; the guide's tables come from this list, and a test keeps them the same.
 * Commands are lists of words, so each shell can quote them its own way.
 */

export interface CodingAgent {
	id: string;
	name: string;
	/**
	 * Commands that install it globally, so the service finds a stable binary. Every agent here
	 * installs from npm with the same words on Linux, macOS and Windows.
	 */
	install: string[][];
	/** Signs in once on this machine; `afterward` says what to do in a session the command opens. */
	signIn: { command: string[]; afterward?: string };
	/**
	 * The oldest Node.js its packages run on, as `major` or `major.minor`, from their `engines` and
	 * checked by `bun run verify:agents`.
	 */
	node: string;
	/** The ACP command `chopin connect` starts, after `--`. */
	acp: string[];
	/** `--env KEY=VALUE` variables the agent needs under Chopin. */
	env: string[];
	/**
	 * Whether it can run under the background service, where nobody can answer a permission prompt;
	 * if not, the setting that makes it approve its own tools.
	 */
	unattended: true | { setting: string };
	docs: string;
	testedWithChopin: boolean;
}

/** One value for every system, or one for each of them. */
export type PerSystem<T> = T | { linux: T; macos: T; windows: T };

/**
 * A setup a deployment offers on the Machines page before the built-in agents, from the server's
 * CHOPIN_SETUP_AGENTS: its install steps (shell lines, shown as they are) and the command that
 * sets up a machine, a template whose `{key}`, `{name}` and `{origin}` are filled in, quoted for
 * the shell. `keyless`, without `{key}`, sets up the computer in front of you; without it the
 * entry is offered only for a server. `default` preselects it for someone who has picked nothing.
 */
export type SetupAgent = {
	id: string;
	name: string;
	install: PerSystem<string[]>;
	command: PerSystem<string>;
	keyless?: PerSystem<string>;
	default?: boolean;
};

/** The value of `value` for `system`. */
export function forSystem<T>(
	value: PerSystem<T>,
	system: "linux" | "macos" | "windows",
): T {
	return value && typeof value === "object" && !Array.isArray(value) && "linux" in value
		? value[system]
		: value as T;
}

export const AGENTS: readonly CodingAgent[] = [
	{
		id: "copilot",
		// verify:agents runs it on Node.js 20 too, but GitHub documents 22 as the minimum.
		node: "22",
		name: "GitHub Copilot CLI",
		install: [["npm", "install", "-g", "@github/copilot"]],
		signIn: { command: ["copilot", "login"] },
		acp: ["copilot", "--acp", "--allow-all"],
		env: [],
		unattended: true,
		docs: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
		testedWithChopin: true,
	},
	{
		id: "atomic",
		node: "22.19",
		name: "Atomic",
		install: [["npm", "install", "-g", "@bastani/atomic", "@bastani/atomic-acp"]],
		signIn: { command: ["atomic"], afterward: "sign in with /login, then quit" },
		acp: ["atomic-acp"],
		// Atomic asks no permission for its tools; this ends its questions at once instead of waiting.
		env: ["ATOMIC_ACP_HEADLESS=1"],
		unattended: true,
		docs: "https://github.com/bastani-inc/atomic-acp",
		testedWithChopin: true,
	},
	{
		id: "claude-code",
		node: "22",
		name: "Claude Code",
		install: [["npm", "install", "-g", "@agentclientprotocol/claude-agent-acp"]],
		// `--cli` opens the Claude Code the adapter bundles; ANTHROPIC_API_KEY works instead.
		signIn: { command: ["claude-agent-acp", "--cli"], afterward: "sign in with /login, then quit" },
		acp: ["claude-agent-acp"],
		env: [],
		unattended: {
			setting:
				'set "defaultMode": "bypassPermissions" under "permissions" in ~/.claude/settings.json',
		},
		docs: "https://github.com/agentclientprotocol/claude-agent-acp",
		testedWithChopin: false,
	},
	{
		id: "codex",
		node: "20",
		name: "OpenAI Codex",
		// The adapter bundles its own Codex; the CLI is for signing in.
		install: [["npm", "install", "-g", "@openai/codex", "@agentclientprotocol/codex-acp"]],
		signIn: { command: ["codex", "login"] },
		acp: ["codex-acp"],
		env: ["INITIAL_AGENT_MODE=agent-full-access"],
		unattended: true,
		docs: "https://github.com/agentclientprotocol/codex-acp",
		testedWithChopin: false,
	},
	{
		id: "gemini",
		node: "20",
		name: "Gemini CLI",
		install: [["npm", "install", "-g", "@google/gemini-cli"]],
		signIn: { command: ["gemini"], afterward: "sign in, then quit" },
		acp: ["gemini", "--acp", "--yolo"],
		env: [],
		unattended: true,
		docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md",
		testedWithChopin: false,
	},
];

export const DEFAULT_AGENT = AGENTS[0]!;

/** The major version of a Node.js version like `22.19` or `v22.19.0`. */
export function nodeMajor(version: string): number {
	return Number(version.replace(/^v/, "").split(".")[0]);
}

/** Whether Node.js `version` (as `node --version` prints it) is older than `minimum`. */
export function nodeOlder(version: string, minimum: string): boolean {
	let have = version.replace(/^v/, "").split(".").map(Number);
	let need = minimum.split(".").map(Number);
	for (let index = 0; index < need.length; index++) {
		if ((have[index] ?? 0) !== need[index]) return (have[index] ?? 0) < need[index]!;
	}
	return false;
}

/** The agent with this id, or the default for an id no longer offered. */
export function findAgent(id: string | null | undefined): CodingAgent {
	return AGENTS.find(agent => agent.id === id) ?? DEFAULT_AGENT;
}
