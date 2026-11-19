/**
 * What `GET /api/ai/usage` says of the signed-in person's own AI requests: those their launches
 * sent through Chopin's credential proxy over the last `AI_USAGE_DAYS` days, by model.
 */

import type { AiProvider } from "./ai-credentials";

/** How many days back the usage summary counts. */
export const AI_USAGE_DAYS = 7;

/**
 * Tokens as the providers reported them: `input` read without the cache, `output` written,
 * `cacheRead` read from the cache and `cacheWrite` written to it. A request whose provider
 * reported no count adds nothing.
 */
export type AiUsageTokens = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

/**
 * One provider's model: how many requests were sent to it, how many ended in an error, and how
 * many are unknown because Chopin restarted before their answer ended. `model` is absent for
 * requests that named none, such as listing the provider's models.
 */
export type AiModelUsage = {
	provider: AiProvider;
	model?: string;
	requests: number;
	errors: number;
	unknown: number;
	tokens: AiUsageTokens;
};

export type AiUsageSummary = {
	/** The start of the period counted, as an ISO 8601 time. */
	since: string;
	/** Most requested first. */
	models: AiModelUsage[];
};
