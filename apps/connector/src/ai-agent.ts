import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AiProvider, AiProviderGrant } from "@chopin/protocol/ai-credentials";
import type { RelayedLaunch } from "./ai-relay";
import { withoutGitHub } from "./github-token";

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
	"CHATGPT_ACCESS_TOKEN",
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

/**
 * The variables of the connector's own environment an agent that runs on Chopin's AI accounts is
 * given, by name: where the system, the person's account and their tools are, its locale, its
 * certificates and its proxy, none of which reaches a model. Everything else the connector was
 * started with is left out, whatever it is called: a provider's key, an agent's configuration, a
 * token of another service. `LC_` variables are kept by their prefix.
 */
const PERMITTED = new Set([
	// The system and the person's account, as POSIX and Windows name them.
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LANGUAGE",
	"TERM",
	"COLORTERM",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"USERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
	// Where the person's tools are installed.
	"PYTHONPATH",
	"PYTHONHOME",
	"PYENV_ROOT",
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"GOPATH",
	"GOROOT",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"JAVA_HOME",
	"DOTNET_ROOT",
	"NODE_PATH",
	"NVM_DIR",
	"NVM_HOME",
	"NVM_SYMLINK",
	"BUN_INSTALL",
	"PNPM_HOME",
	"VOLTA_HOME",
	"DENO_INSTALL",
	"GEM_HOME",
	"GEM_PATH",
	"RBENV_ROOT",
	"SDKMAN_DIR",
	"ASDF_DIR",
	"ASDF_DATA_DIR",
	"HOMEBREW_PREFIX",
	"HOMEBREW_CELLAR",
	"HOMEBREW_REPOSITORY",
	"MANPATH",
	"INFOPATH",
	"VCINSTALLDIR",
	"VSINSTALLDIR",
	"PSMODULEPATH",
	"VCPKG_ROOT",
	// Certificates and the network's proxy, which a sandbox replaces with its own.
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"GIT_SSL_CAINFO",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
]);

/** `env` with only what `PERMITTED` names, by name in any case. */
export function permittedEnvironment<T extends string | undefined>(
	env: Record<string, T>,
): Record<string, T> {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => {
			let upper = name.toUpperCase();
			return PERMITTED.has(upper) || upper.startsWith("LC_");
		}),
	);
}

/**
 * Where an agent that runs on Chopin's AI accounts starts from, before what Chopin and the connector
 * give it: the connector's own environment as `PERMITTED` allows, and the owner's `--env` values
 * (which they chose for every agent) without their GitHub setup or anything of their agents'
 * (`OWNER_AGENT_VARIABLES`).
 */
export function managedEnvironment(
	host: Record<string, string | undefined>,
	given: Record<string, string> = {},
): Record<string, string> {
	let permitted = permittedEnvironment(host);
	return {
		...Object.fromEntries(
			Object.entries(permitted).filter((entry): entry is [string, string] =>
				entry[1] !== undefined
			),
		),
		...withoutOwnerAgent(withoutGitHub(given)),
	};
}

/**
 * Makes `home` an agent state directory of the launch's own and returns the variables that move
 * every agent's state and configuration directory into it, so none of the owner's is read or
 * written: Atomic's (and Pi's), Copilot's, Claude's and Codex's.
 */
export function privateAgentState(home: string): Record<string, string> {
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
	return places;
}

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

/**
 * Atomic's providers for each of Chopin's, the API-key-only ones included. A ChatGPT or Claude
 * sign-in is Atomic's `openai` or `anthropic`, which take a subscription, ahead of a key for the
 * same provider, which keeps its API-key-only provider.
 */
const ATOMIC_PROVIDERS: Record<AiProvider, string[]> = {
	"github-copilot": ["github-copilot"],
	openai: ["openai", "openai-api"],
	anthropic: ["anthropic", "anthropic-api"],
	chatgpt: ["openai"],
	claude: ["anthropic"],
};

/** The provider whose own clients' variables a subscription takes when no key for it is granted. */
const SIGNED_IN_FOR: Partial<Record<AiProvider, AiProvider>> = {
	chatgpt: "openai",
	claude: "anthropic",
};

/** The grants with each subscription after any key, so the subscription is the one that stays. */
function keysFirst(providers: readonly AiProviderGrant[]): AiProviderGrant[] {
	return [...providers].sort((left, right) =>
		Number(left.provider in SIGNED_IN_FOR) - Number(right.provider in SIGNED_IN_FOR)
	);
}

/**
 * Copilot's model API takes the Copilot token Chopin exchanges for the person's GitHub token, as an
 * editor's sign-in does, so the agent sends the headers of one. Where Chopin sends a GitHub token
 * Copilot takes itself instead, its proxy replaces them with the ones that token needs.
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
	for (let grant of keysFirst(providers)) {
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
 * The variable that holds, for any agent, each granted provider's base URL on the relay with the
 * stand-in to send it as its key, together: a JSON array of `{ provider, baseUrl, apiKey,
 * keyVariable, headers? }`, `headers` being what the provider's API expects of an agent with that
 * key (Copilot's). An agent that reads no provider's own variables reaches each provider with its
 * pair alone; see `docs/chopin-cli.md`.
 */
export const AI_PROVIDERS_VARIABLE = "CHOPIN_AI_PROVIDERS";

/**
 * Prepares `home`, an agent state directory of the launch's own, and returns what the agent's
 * environment gets from the launch: each granted provider's base URL on the relay with its stand-in,
 * together, in `CHOPIN_AI_PROVIDERS`; each provider's key variable set to its stand-in and the base
 * URL variables the providers' own clients read pointed at the relay; and every agent's state and
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
	let places = privateAgentState(home);
	let atomic = places.ATOMIC_CODING_AGENT_DIR;
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
		[AI_PROVIDERS_VARIABLE]: JSON.stringify(
			providers.flatMap(grant => {
				let baseUrl = relayed.baseUrls[grant.provider];
				return baseUrl
					? [{
						provider: grant.provider,
						baseUrl,
						apiKey: grant.placeholder,
						keyVariable: grant.keyVariable,
						...(grant.provider === "github-copilot" ? { headers: COPILOT_HEADERS } : {}),
					}]
					: [];
			}),
		),
	};
	let keyed = new Set(providers.map(grant => grant.provider));
	for (let grant of providers) {
		let baseUrl = relayed.baseUrls[grant.provider];
		if (!baseUrl) continue;
		env[grant.keyVariable] = grant.placeholder;
		let own = SIGNED_IN_FOR[grant.provider];
		let as = own && keyed.has(own) ? undefined : own ?? grant.provider;
		if (as === "openai") env.OPENAI_BASE_URL = baseUrl;
		if (as === "anthropic") env.ANTHROPIC_BASE_URL = baseUrl;
		if (grant.provider === "chatgpt" && as === "openai") env.OPENAI_API_KEY = grant.placeholder;
	}
	return env;
}
