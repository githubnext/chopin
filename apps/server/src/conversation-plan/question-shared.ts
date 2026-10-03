import type { JevQuestion } from "./jev";

export const QUESTION_SET_VERSION = "conversation-plan-8";

export const FOUR_CANDIDATE_QUESTIONS = new Set([
	"role",
	"thread",
	"option",
	"chosen_option",
	"new_option",
	"planning_substance",
	"support",
	"objection",
	"duplicate",
	"explicit_resolution",
]);

/** Schedule a dedicated judgment only for wording that can directly retract a stance. */
export function hasWithdrawalCue(quote: string): boolean {
	return /\b(?:withdraw|retract|take\s+back|no\s+longer|chang(?:e|ed)\s+my\s+mind|not\s+going\s+with|scratch\s+that)\b/i
		.test(quote);
}

export type LinkedCardOptions = ReadonlyMap<string, {
	cardId: string;
	options: ReadonlyArray<{ id: string; label: string }>;
}>;

export function noul(instructions: string, yes: string, no: string): JevQuestion {
	return { type: "noul", instructions, criteria: { true: yes, false: no } };
}
