/** GitHub's API origin, which exchanges a GitHub token for a Copilot token. */
export const GITHUB_API = "https://api.github.com";

/**
 * The reasons GitHub names (`error_details.notification_id`) when it refuses a Copilot token because
 * the account itself has no Copilot subscription: none, never signed up, or one that ended.
 */
const NO_SEAT = new Set(["no_copilot_access", "not_signed_up", "subscription_ended"]);

/**
 * Whether GitHub refused for its rate limit rather than for the account: a 429, or a 403 that says
 * when to try again (`Retry-After`) or that no request is left (`X-RateLimit-Remaining: 0`).
 */
function throttled(response: Response): boolean {
	return response.status === 429
		|| response.status === 403
			&& (response.headers.has("retry-after")
				|| response.headers.get("x-ratelimit-remaining")?.trim() === "0");
}

/** The hosts a Copilot token may name as its model API; any other answer keeps the default. */
const COPILOT_API = /^https:\/\/api\.(?:[a-z0-9-]+\.)*githubcopilot\.com$/;

/**
 * Copilot's model API, which routes each account to its own host. It also takes a GitHub token
 * itself, as Copilot's own CLI sends one, from whichever app the token came from.
 */
export const COPILOT_MODEL_API = "https://api.githubcopilot.com";

/** What Copilot's model API is sent with a GitHub token itself: the integration Copilot's CLI is. */
export const COPILOT_RAW_TOKEN_HEADERS = { "copilot-integration-id": "copilot-developer-cli" };

/** How long Copilot's model API taking a GitHub token is relied on, as a Copilot token's life is. */
const RAW_ANSWER_MS = 30 * 60_000;

/**
 * What Copilot's model API takes for a GitHub token, until `expiresAt` (milliseconds since the
 * epoch): the Copilot token GitHub exchanges it for, at `api` when GitHub names the account's own
 * host; or, when GitHub won't exchange it but Copilot's model API takes it (`raw`), the GitHub
 * token itself, sent to `COPILOT_MODEL_API` alone with `COPILOT_RAW_TOKEN_HEADERS`.
 */
export type CopilotToken = { token: string; expiresAt: number; api?: string; raw?: true };

/**
 * What Copilot's model API takes for a GitHub token; undefined when GitHub refuses a Copilot token
 * because the account has no Copilot subscription.
 */
export type CopilotTokenExchange = (githubToken: string) => Promise<CopilotToken | undefined>;

function exchanged(body: unknown): CopilotToken {
	let value = body as { token?: unknown; expires_at?: unknown; endpoints?: { api?: unknown } };
	if (
		!value || typeof value.token !== "string" || !value.token
		|| typeof value.expires_at !== "number" || !Number.isFinite(value.expires_at)
	) {
		throw new Error("GitHub answered a Copilot token exchange without a token");
	}
	let api = typeof value.endpoints?.api === "string"
		? value.endpoints.api.replace(/\/+$/, "")
		: undefined;
	return {
		token: value.token,
		expiresAt: value.expires_at * 1000,
		...(api && COPILOT_API.test(api) ? { api } : {}),
	};
}

/**
 * Whether GitHub's refusal says the account has no Copilot subscription, as it tells Copilot's own
 * clients: a JSON body whose `error_details.notification_id` is one of `NO_SEAT`. Any other refusal
 * (a token GitHub won't exchange at all, as one from an app that isn't one of Copilot's clients
 * gets whatever the account has, a token it no longer accepts, a reason other than a seat) says
 * nothing about the subscription.
 */
async function noSeat(response: Response): Promise<boolean> {
	let body: unknown;
	try {
		body = JSON.parse(await response.text());
	} catch {
		return false;
	}
	let id = (body as { error_details?: { notification_id?: unknown } } | null)?.error_details
		?.notification_id;
	return typeof id === "string" && NO_SEAT.has(id);
}

/**
 * Asks GitHub for a Copilot token with `githubToken`, the person's GitHub sign-in or the token
 * they connected: the token when GitHub gives one, undefined when it refuses one saying the account
 * has no Copilot subscription. GitHub exchanges only the tokens of Copilot's own clients, so it
 * refuses others whatever the account has (a GitHub App's user token, another app's OAuth token or
 * a personal access token, a seat-holder's included); then Copilot's model API is asked whether it
 * takes the GitHub token itself, as Copilot's own CLI sends one (its model list, `GET /models`), and
 * the token is used that way when it does. Throws when neither can be asked or answers anything else,
 * which says nothing about the account, a refusal for GitHub's rate limit included.
 */
export function copilotTokenExchange(
	options: {
		api?: string;
		copilotApi?: string;
		fetch?: typeof fetch;
		clock?: () => number;
	} = {},
): CopilotTokenExchange {
	let send = options.fetch ?? fetch;
	let api = options.api ?? GITHUB_API;
	let copilotApi = options.copilotApi ?? COPILOT_MODEL_API;
	let clock = options.clock ?? Date.now;
	return async githubToken => {
		let response = await send(`${api}/copilot_internal/v2/token`, {
			headers: {
				accept: "application/json",
				authorization: `token ${githubToken}`,
				"x-github-api-version": "2022-11-28",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		if (response.ok) return exchanged(await response.json());
		let refused = `GitHub answered ${response.status} to a Copilot token exchange`;
		if (throttled(response)) {
			await response.body?.cancel();
			throw new Error(refused);
		}
		if (await noSeat(response)) return undefined;
		let models = await send(`${copilotApi}/models`, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${githubToken}`,
				...COPILOT_RAW_TOKEN_HEADERS,
			},
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		await models.body?.cancel();
		if (models.ok) return { token: githubToken, expiresAt: clock() + RAW_ANSWER_MS, raw: true };
		throw new Error(`${refused}, and Copilot's model API ${models.status} to the GitHub token`);
	};
}
