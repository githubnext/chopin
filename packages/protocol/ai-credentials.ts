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
 * Whether a GitHub sign-in can use GitHub Copilot: `access`, `none` when GitHub refused it a
 * Copilot token (the account has no Copilot subscription), or `unknown` when Chopin couldn't ask.
 */
export type CopilotAccess = "access" | "none" | "unknown";

/** What `GET /api/ai/credentials` says of one connected provider; never the secret. */
export type AiCredentialSummary = {
	provider: AiProvider;
	kind: AiCredentialKind;
	/** When it was connected or last replaced, as an ISO 8601 time. */
	updatedAt: string;
	/** For a GitHub sign-in: whether it has Copilot access now. */
	copilotAccess?: CopilotAccess;
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

/** The path under Chopin's origin each provider's proxied API is served at. */
export const AI_PROXY_PATH = "/api/v1/ai";

export function isAiProvider(value: unknown): value is AiProvider {
	return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}
