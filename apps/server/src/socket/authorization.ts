import type { AuthorizationResult } from "../wire";

type AuthorizationRefreshState = {
	closed?: boolean;
	authorizationRefresh?: Promise<AuthorizationResult>;
};

/** Share ordinary checks, but keep a forced repository check fresh after an in-flight result. */
export async function refreshAuthorization(
	state: AuthorizationRefreshState,
	forceGitHub: boolean,
	check: (forceGitHub: boolean) => Promise<AuthorizationResult>,
): Promise<AuthorizationResult> {
	if (state.closed) return "denied";
	if (state.authorizationRefresh) {
		let result = await state.authorizationRefresh;
		if (result !== "allowed" || !forceGitHub) return result;
	}
	let refresh = check(forceGitHub);
	state.authorizationRefresh = refresh;
	try {
		return await refresh;
	} finally {
		if (state.authorizationRefresh === refresh) state.authorizationRefresh = undefined;
	}
}
