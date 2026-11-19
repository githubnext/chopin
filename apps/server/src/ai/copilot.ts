/** GitHub's API origin, which exchanges a GitHub token for a Copilot token. */
export const GITHUB_API = "https://api.github.com";

/** Statuses with which GitHub refuses a Copilot token: the account has no Copilot access. */
const REFUSED = new Set([401, 403, 404]);

/** The hosts a Copilot token may name as its model API; any other answer keeps the default. */
const COPILOT_API = /^https:\/\/api\.(?:[a-z0-9-]+\.)*githubcopilot\.com$/;

/**
 * The Copilot token GitHub exchanges a GitHub token for: what Copilot's model API takes, until
 * `expiresAt` (milliseconds since the epoch), at `api` when GitHub names the account's own host.
 */
export type CopilotToken = { token: string; expiresAt: number; api?: string };

/** Exchanges a GitHub token for a Copilot token; undefined when GitHub refuses one. */
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
 * Asks GitHub for a Copilot token with `githubToken`, the person's GitHub sign-in or the token
 * they connected: the token when GitHub gives one, undefined when it refuses (the account has no
 * Copilot subscription). Throws when GitHub can't be asked or answers anything else, which says
 * nothing about the account.
 */
export function copilotTokenExchange(
	options: { api?: string; fetch?: typeof fetch } = {},
): CopilotTokenExchange {
	let send = options.fetch ?? fetch;
	let api = options.api ?? GITHUB_API;
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
		await response.body?.cancel();
		if (REFUSED.has(response.status)) return undefined;
		throw new Error(`GitHub answered ${response.status} to a Copilot token exchange`);
	};
}
