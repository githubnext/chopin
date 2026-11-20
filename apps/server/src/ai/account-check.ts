import { PLANNER_NAME } from "@chopin/protocol/planner-name";

import { AiCredentialError } from "./credentials";

import type { Session } from "@chopin/protocol";
import type { AiCredentials, AiWithheld } from "./credentials";

/** Why a message to the Planner was refused for the sender's AI accounts, as `session:error` says it. */
export type AiAccountRefusal = {
	message: string;
	code: Extract<Session.Failure["code"], "no-ai-account" | "temporarily-unavailable">;
};

export const NO_AI_ACCOUNT =
	`${PLANNER_NAME} needs an AI account to answer, so this message wasn't sent. Add one, then send it again.`;

export const AI_ACCOUNT_UNCHECKED =
	`${PLANNER_NAME} couldn't finish checking your AI accounts, so this message wasn't sent. Send it again in a moment.`;

const AI_ACCOUNTS_CHANGING = `${PLANNER_NAME} couldn't read your AI accounts just now.`;

/**
 * Why a Planner session was not started: the account its launch is for has no AI account Chopin can
 * use, as a message from someone with none is refused. Its start is refused, and its turn says so.
 */
export const NO_AI_ACCOUNT_SESSION =
	`${PLANNER_NAME} needs an AI account to answer, so it didn't start. Add one, then try again.`;

export const AI_ACCOUNT_UNCHECKED_SESSION =
	`${PLANNER_NAME} couldn't finish checking your AI accounts, so it didn't start. Try again in a moment.`;

/**
 * Withheld for a question with no answer about the account: GitHub couldn't be asked or answered
 * nothing about it, or the person's own sign-in couldn't be read.
 */
const UNANSWERED = new Set<AiWithheld["reason"]>(["copilot-unavailable", "sign-in-unavailable"]);

/**
 * Whether a message from `userId` to the Planner must be refused because a launch for them would be
 * given no provider: undefined when it would be given one. With no Copilot access and no key it is
 * `no-ai-account`, saying they need one; where Copilot couldn't be checked and they have no key it is
 * `no-ai-account` too, saying the check couldn't finish, never that they have no subscription. Their
 * accounts changing while they were read, or storage failing, is a passing refusal.
 */
export async function aiAccountRefusal(
	credentials: Pick<AiCredentials, "available">,
	userId: string,
): Promise<AiAccountRefusal | undefined> {
	let available;
	try {
		available = await credentials.available(userId);
	} catch (err) {
		if (!(err instanceof AiCredentialError && err.status === 503)) {
			console.error("[ai] could not read a person's AI accounts before a Planner turn:", err);
		}
		return { message: AI_ACCOUNTS_CHANGING, code: "temporarily-unavailable" };
	}
	if (available.providers.length) return undefined;
	let unanswered = available.withheld.some(withheld => UNANSWERED.has(withheld.reason));
	return { message: unanswered ? AI_ACCOUNT_UNCHECKED : NO_AI_ACCOUNT, code: "no-ai-account" };
}
