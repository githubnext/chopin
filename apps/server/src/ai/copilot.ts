/** GitHub's API origin, which answers whether a GitHub token may have a Copilot token. */
export const GITHUB_API = "https://api.github.com";

/** Statuses with which GitHub refuses a Copilot token: the account has no Copilot access. */
const REFUSED = new Set([401, 403, 404]);

/**
 * Asks GitHub for a Copilot token with `token`, the person's GitHub sign-in: true when GitHub
 * gives one, false when it refuses (no Copilot subscription for this account). Throws when GitHub
 * can't be asked or answers anything else, which says nothing about the account. The token it
 * gives is not kept: it only proves the entitlement.
 */
export function copilotEntitlement(
	options: { api?: string; fetch?: typeof fetch } = {},
): (token: string) => Promise<boolean> {
	let send = options.fetch ?? fetch;
	let api = options.api ?? GITHUB_API;
	return async token => {
		let response = await send(`${api}/copilot_internal/v2/token`, {
			headers: {
				accept: "application/json",
				authorization: `token ${token}`,
				"x-github-api-version": "2022-11-28",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		await response.body?.cancel();
		if (response.ok) return true;
		if (REFUSED.has(response.status)) return false;
		throw new Error(`GitHub answered ${response.status} to a Copilot entitlement check`);
	};
}
