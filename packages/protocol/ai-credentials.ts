/**
 * AI credentials a person connects in Chopin, and what a launch is handed in their place.
 *
 * A credential never leaves the server: the API says only which providers a person connected and
 * how, and a launch gets a random placeholder per provider with a base URL on Chopin's credential
 * proxy, which swaps the placeholder for the real credential and forwards to that provider alone.
 */

import { PLANNER_NAME } from "./planner-name";

export const AI_PROVIDERS = ["github-copilot", "openai", "anthropic", "chatgpt", "claude"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * The subscriptions a person signs in to rather than give a key for: `chatgpt` through Sign in with
 * ChatGPT, sent to OpenAI's API, and `claude` through Claude's sign-in, sent to Anthropic's API.
 */
export const SUBSCRIPTION_PROVIDERS = ["chatgpt", "claude"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
	return typeof value === "string"
		&& (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * How a person connected a provider: `api-key` is a key or token they gave Chopin, kept encrypted;
 * `github-sign-in` is GitHub Copilot through the GitHub sign-in Chopin already holds for them,
 * renewed by Chopin; `subscription` is a ChatGPT or Claude sign-in, whose tokens Chopin keeps
 * encrypted and refreshes.
 */
export type AiCredentialKind = "api-key" | "github-sign-in" | "subscription";

/**
 * Whether a connected GitHub Copilot can be used: `access`; `none` when GitHub refused its GitHub
 * token a Copilot token saying the account has no Copilot subscription; or `unknown` when Chopin
 * couldn't find out: GitHub couldn't be asked, or neither GitHub's exchange nor Copilot's model API
 * took the token, which says nothing about the subscription.
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
	/**
	 * For a subscription whose access token had expired: Chopin couldn't renew it just now, so it
	 * can't say whether the sign-in still works.
	 */
	unchecked?: true;
};

export type AiCredentialList = { credentials: AiCredentialSummary[] };

/** The body of `PUT /api/ai/credentials/:provider`. */
export type ConnectAiCredential =
	| { kind: "api-key"; secret: string }
	| { kind: "github-sign-in" };

/**
 * What `POST /api/ai/sign-ins/:provider` answers: the provider's page where the person signs in,
 * which ends on a page that shows what they paste back.
 */
export type AiSignInStart = { url: string };

/**
 * The body of `POST /api/ai/sign-ins/:provider/finish`: for ChatGPT the full address the browser
 * was sent to after signing in, for Claude the code Claude shows.
 */
export type AiSignInFinish = { input: string };

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
	chatgpt: "CHATGPT_ACCESS_TOKEN",
	claude: "CLAUDE_CODE_OAUTH_TOKEN",
};

/**
 * The header in which a launch's runner presents the launch's own credential with every proxied
 * request. The runner adds it on its way out and never hands it to the agent, so a placeholder
 * alone, copied out of one launch, reaches nothing from another.
 */
export const AI_LAUNCH_HEADER = "x-chopin-launch";

/** The page where a person connects their AI accounts, which a refusal for want of one links to. */
export const AI_ACCOUNTS_PATH = "/ai-accounts";

/**
 * Why a build, investigation or prototype did not start: Chopin answered its launch that the person
 * it runs for has no AI account it can use (`no-ai-account`), so its agent was never started. The
 * run's end says so, in these words, and its starter is offered AI accounts.
 */
export const NO_AI_ACCOUNT_RUN =
	`${PLANNER_NAME} needs an AI account to run this, so it didn't start. Add one, then start it again.`;

/**
 * The same, where GitHub couldn't be asked about the person's Copilot access and they have no key:
 * the check couldn't finish, which never says they have no subscription.
 */
export const AI_ACCOUNT_UNCHECKED_RUN =
	`${PLANNER_NAME} couldn't finish checking your AI accounts, so this didn't start. Start it again in a moment.`;

/** Whether a run's end is one for want of an AI account, whose starter is offered AI accounts. */
export function noAiAccountRun(error: string | undefined): boolean {
	return error === NO_AI_ACCOUNT_RUN || error === AI_ACCOUNT_UNCHECKED_RUN;
}

/** The path under Chopin's origin each provider's proxied API is served at. */
export const AI_PROXY_PATH = "/api/v1/ai";

export function isAiProvider(value: unknown): value is AiProvider {
	return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}
