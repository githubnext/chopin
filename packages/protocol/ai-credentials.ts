/**
 * AI credentials a person connects in Chopin, and what a launch is handed in their place.
 *
 * A credential never leaves the server: the API says only which providers a person connected and
 * how, and a launch gets a random placeholder per provider with a base URL on Chopin's credential
 * proxy, which swaps the placeholder for the real credential and forwards to that provider alone.
 */

export const AI_PROVIDERS = ["github-copilot", "openai", "anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * How a person connected a provider: `api-key` is a key or token they gave Chopin, kept encrypted;
 * `github-sign-in` is GitHub Copilot through the GitHub sign-in Chopin already holds for them,
 * renewed by Chopin.
 */
export type AiCredentialKind = "api-key" | "github-sign-in";

/**
 * Whether a connected GitHub Copilot can be used: `access`, `none` when GitHub refused its GitHub
 * token a Copilot token (the account has no Copilot subscription), or `unknown` when Chopin
 * couldn't ask.
 */
export type CopilotAccess = "access" | "none" | "unknown";

/**
 * What `GET /api/ai/credentials` says of one connected provider; never the secret. GitHub Copilot is
 * always listed: through the person's GitHub sign-in until they connect a token instead.
 */
export type AiCredentialSummary = {
	provider: AiProvider;
	kind: AiCredentialKind;
	/**
	 * When it was connected or last replaced, as an ISO 8601 time; absent for GitHub Copilot through
	 * the GitHub sign-in when the person never connected anything for it.
	 */
	updatedAt?: string;
	/** A key's last four characters, to tell keys apart; never more of it. */
	suffix?: string;
	/**
	 * When a launch last sent a request with it, as an ISO 8601 time, to the minute; absent when none
	 * has since it was connected.
	 */
	lastUsedAt?: string;
	/**
	 * When its provider answered a request with this key that the key is invalid, as an ISO 8601
	 * time: no launch is given it, and it needs connecting again. Absent while none has.
	 */
	rejectedAt?: string;
	/** For GitHub Copilot: whether it has Copilot access, as GitHub said in the last few minutes. */
	copilotAccess?: CopilotAccess;
	unusable?: true;
};

export type AiCredentialList = { credentials: AiCredentialSummary[] };

/** The body of `PUT /api/ai/credentials/:provider`. */
export type ConnectAiCredential =
	| { kind: "api-key"; secret: string }
	| { kind: "github-sign-in" };

/**
 * One provider as a launch is given it: the agent sends `placeholder` as its key to `baseUrl`,
 * and reads it from `keyVariable` where it takes its key from the environment.
 */
export type AiProviderGrant = {
	provider: AiProvider;
	baseUrl: string;
	placeholder: string;
	keyVariable: string;
};

/** The environment variable each provider's agents read their key from. */
export const AI_KEY_VARIABLES: Record<AiProvider, string> = {
	"github-copilot": "COPILOT_GITHUB_TOKEN",
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
};

/**
 * The header in which a launch's runner presents the launch's own credential with every proxied
 * request. The runner adds it on its way out and never hands it to the agent, so a placeholder
 * alone, copied out of one launch, reaches nothing from another.
 */
export const AI_LAUNCH_HEADER = "x-chopin-launch";

/** The path under Chopin's origin each provider's proxied API is served at. */
export const AI_PROXY_PATH = "/api/v1/ai";

export function isAiProvider(value: unknown): value is AiProvider {
	return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}
