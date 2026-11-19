import type { AiGrants } from "@chopin/agent-link";
import type { AiCredentials, AiLaunch, AiWithheld } from "./credentials";

/**
 * How long a Planner session's launch lasts. The agent connection launches it again before then,
 * and whenever its person's credentials change.
 */
export const PLANNER_AI_LAUNCH_MS = 12 * 60 * 60_000;

/** How long a build's or run's launch lasts: past the longest a build's agent may work. */
export const RUN_AI_LAUNCH_MS = 5 * 60 * 60_000;

/** How long before its deadline a lasting launch is prepared again. */
export const AI_RENEW_BEFORE_MS = 30 * 60_000;

/** What a runner is handed for one launch, and the id the launch is ended by. */
export type HandedOut = { launchId: string; grants: AiGrants };

/** Withheld for a question nobody answered: GitHub, or the person's own sign-in, couldn't be asked. */
const UNANSWERED = new Set<AiWithheld["reason"]>(["copilot-unavailable", "sign-in-unavailable"]);

/**
 * Why a launch was handed out with nothing, which starts no agent: the person it runs for has no AI
 * account Chopin can use (`no-ai-account`, `unchecked` where GitHub couldn't be asked about their
 * Copilot access and they have no key, which never means they have no subscription), or the launch
 * ended before it was handed out (`launch-ended`: its document archived, its machine revoked or
 * its grants taken back with the machine's, or its deadline passed).
 */
export class AiLaunchRefused extends Error {
	override name = "AiLaunchRefused";
	constructor(
		readonly code: "no-ai-account" | "launch-ended",
		/** What the person connected that the launch was not given, and why. */
		readonly withheld: AiGrants["withheld"] = [],
		readonly unchecked = false,
	) {
		super(
			code === "launch-ended"
				? "This launch ended before it started."
				: unchecked
				? "Chopin couldn't finish checking this person's AI accounts."
				: "This person has no AI account Chopin can use.",
		);
	}
}

/**
 * Prepares one launch for the person `input` names and turns its result into what a runner gets,
 * on the agent connection and the connector alike: the launch's own credential, its deadline and
 * one stand-in per granted provider, never a credential of the person's. This is where a launch's
 * result is decided on: one that would be given no provider is never handed out, so no runner
 * starts an agent on anything but the person's own accounts in Chopin, and it throws why
 * (`AiLaunchRefused`); a retryable failure to prepare it throws (`AiCredentialError`).
 */
export async function handOut(credentials: AiCredentials, input: AiLaunch): Promise<HandedOut> {
	let launched = await credentials.launch(input);
	let withheld = launched.withheld.map(({ provider, reason }) => ({ provider, reason }));
	if (launched.ended) throw new AiLaunchRefused("launch-ended", withheld);
	if (!launched.grants.length) {
		throw new AiLaunchRefused(
			"no-ai-account",
			withheld,
			launched.withheld.some(value => UNANSWERED.has(value.reason)),
		);
	}
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

/**
 * Ends a launch: nothing more is admitted for it from now on. An end storage refuses is said in the
 * log and tried again (see `AiCredentials.end`).
 */
export function endLaunch(credentials: AiCredentials, launchId: string): void {
	void credentials.end(launchId).catch(err =>
		console.error("chopin: could not end an AI launch -", err)
	);
}
