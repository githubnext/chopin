import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AiProvider, AiProviderGrant } from "@chopin/protocol/ai-credentials";
import type { RelayedLaunch } from "./ai-relay";

/**
 * The variables in which the owner's environment may hand an agent model credentials or the
 * agent's own configuration. A run handed AI grants gets none of them from the owner: its keys are
 * stand-ins and its configuration is its own (see `agentAiEnvironment`).
 */
export const OWNER_AGENT_VARIABLES = new Set([
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_ORG_ID",
	"OPENAI_PROJECT_ID",
	"AZURE_OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"GH_COPILOT_TOKEN",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"OPENROUTER_API_KEY",
	"ATOMIC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_ARTIFACT_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_PROFILE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
	"ATOMIC_MODEL_CATALOG_URL",
	"PI_MODEL_CATALOG_URL",
	"COPILOT_HOME",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
]);

/** `env` without anything of the owner's agent setup: their model credentials and configuration. */
export function withoutOwnerAgent<T extends string | undefined>(
	env: Record<string, T>,
): Record<string, T> {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !OWNER_AGENT_VARIABLES.has(name.toUpperCase())),
	);
}

/** Whether a command starts Atomic, whose models come from a `models.json` in its agent directory. */
export function atomicAgent(command: readonly string[]): boolean {
	let program = basename((command[0] ?? "").replaceAll("\\", "/")).replace(
		/\.(exe|cmd|bat|ps1)$/i,
		"",
	);
	return program === "atomic" || program === "atomic-acp";
}

/** Atomic's providers for each of Chopin's, the API-key-only ones included. */
const ATOMIC_PROVIDERS: Record<AiProvider, string[]> = {
	"github-copilot": ["github-copilot"],
	openai: ["openai", "openai-api"],
	anthropic: ["anthropic", "anthropic-api"],
};

/**
 * Copilot's model API takes the Copilot token Chopin exchanges for the person's GitHub token, as an
 * editor's sign-in does, so the agent sends the headers of one.
 */
const COPILOT_HEADERS = { "Copilot-Integration-Id": "vscode-chat" };

/**
 * Atomic's `models.json` for a launch: each granted provider at its base URL on the relay, its key
 * read from the provider's key variable, which holds the stand-in.
 */
export function atomicModels(
	providers: readonly AiProviderGrant[],
	relayed: Pick<RelayedLaunch, "baseUrls">,
) {
	let entries: Record<string, Record<string, unknown>> = {};
	for (let grant of providers) {
		let baseUrl = relayed.baseUrls[grant.provider];
		if (!baseUrl) continue;
		for (let name of ATOMIC_PROVIDERS[grant.provider]) {
			entries[name] = {
				baseUrl,
				apiKey: `$${grant.keyVariable}`,
				...(grant.provider === "github-copilot" ? { headers: COPILOT_HEADERS } : {}),
			};
		}
	}
	return { providers: entries };
}

/**
 * Prepares `home`, an agent state directory of the launch's own, and returns what the agent's
 * environment gets from the launch: each provider's key variable set to its stand-in, the base URL
 * variables the providers' own clients read pointed at the relay, and every agent's state and
 * configuration directory moved into `home`, so none of the owner's is read or written. An Atomic
 * agent also finds there a `models.json` that sends each granted provider through the relay. The
 * launch's own credential is in none of it: the relay adds it.
 */
export function agentAiEnvironment(options: {
	command: readonly string[];
	home: string;
	providers: readonly AiProviderGrant[];
	relayed: Pick<RelayedLaunch, "baseUrls" | "catalogUrl">;
}): Record<string, string> {
	let { home, providers, relayed } = options;
	let atomic = join(home, "atomic");
	let places = {
		ATOMIC_CODING_AGENT_DIR: atomic,
		PI_CODING_AGENT_DIR: atomic,
		COPILOT_HOME: join(home, "copilot"),
		CLAUDE_CONFIG_DIR: join(home, "claude"),
		CODEX_HOME: join(home, "codex"),
	};
	for (let directory of new Set(Object.values(places))) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	if (atomicAgent(options.command)) {
		writeFileSync(
			join(atomic, "models.json"),
			JSON.stringify(atomicModels(providers, relayed), null, "\t") + "\n",
			{ mode: 0o600 },
		);
	}
	let env: Record<string, string> = {
		...places,
		ATOMIC_MODEL_CATALOG_URL: relayed.catalogUrl,
	};
	for (let grant of providers) {
		let baseUrl = relayed.baseUrls[grant.provider];
		if (!baseUrl) continue;
		env[grant.keyVariable] = grant.placeholder;
		if (grant.provider === "openai") env.OPENAI_BASE_URL = baseUrl;
		if (grant.provider === "anthropic") env.ANTHROPIC_BASE_URL = baseUrl;
	}
	return env;
}
