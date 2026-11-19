import type { AiGrants } from "@chopin/agent-link";
import type { AiCredentials, AiLaunch } from "./credentials";

/**
 * How long a Planner session's launch lasts. The agent connection launches it again before then,
 * and whenever its person's credentials change.
 */
export const PLANNER_AI_LAUNCH_MS = 12 * 60 * 60_000;

/** How long a build's or run's launch lasts: past the longest a build's agent may work. */
export const RUN_AI_LAUNCH_MS = 5 * 60 * 60_000;

/** How long before its deadline a lasting launch is prepared again. */
export const AI_RENEW_BEFORE_MS = 30 * 60_000;

/**
 * What a runner is handed for one launch, and the id the launch is ended by. `launchId` is absent
 * when the launch was given nothing: no runner credential exists then, and `grants` lists only
 * what was withheld.
 */
export type HandedOut = { launchId?: string; grants: AiGrants };

/**
 * Prepares one launch for the person `input` names and turns its result into what a runner gets,
 * on the agent connection and the connector alike: the launch's own credential, its deadline and
 * one stand-in per granted provider, never a credential of the person's. This is where a launch's
 * result is decided on, so a launch given no provider is handed out here as one with an empty
 * `providers`; a retryable failure to prepare it throws (`AiCredentialError`).
 */
export async function handOut(credentials: AiCredentials, input: AiLaunch): Promise<HandedOut> {
	let launched = await credentials.launch(input);
	let withheld = launched.withheld.map(({ provider, reason }) => ({ provider, reason }));
	if (!launched.grants.length) return { grants: { providers: [], withheld } };
	return {
		launchId: launched.launchId,
		grants: {
			launch: launched.launchToken,
			expiresAt: input.expiresAt.getTime(),
			providers: launched.grants.map(grant => ({
				provider: grant.provider,
				baseUrl: grant.baseUrl,
				placeholder: grant.placeholder,
				keyVariable: grant.keyVariable,
			})),
			withheld,
		},
	};
}

/** Ends a launch, saying in the log when it could not; its deadline ends it either way. */
export function endLaunch(credentials: AiCredentials, launchId: string): void {
	void credentials.end(launchId).catch(err =>
		console.error("chopin: could not end an AI launch -", err)
	);
}
