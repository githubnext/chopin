import type { Chat as WireChat } from "@chopin/protocol";

import { effectivePreference } from "./preference";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations/property nodes; synchronous wrappers only.
export function promptText(title: string): string {
	return `Ready to decide: ${title}`;
}

export function sameSource(
	current: ReturnType<typeof effectivePreference>,
	optionId: string | undefined,
	messageIds: readonly string[],
): boolean {
	let currentIds = current?.messageIds ?? [];
	return current?.optionId === optionId && currentIds.length === messageIds.length
		&& currentIds.every((id, index) => id === messageIds[index]);
}

export function shouldPrompt(
	entries: readonly WireChat.Entry[],
	questionnaireId: string,
	record: { status: string; history: readonly unknown[] },
	generation: number,
	source?: { optionId?: string; messageIds: readonly string[] },
): boolean {
	if (record.status !== "open" && record.status !== "reopened") return false;
	if (record.history.length !== generation) return false;
	for (let index = entries.length - 1; index >= 0; index--) {
		let decision = entries[index]?.decision;
		if (
			decision?.kind !== "prompt" || decision.questionnaireId !== questionnaireId
			|| decision.generation !== generation
		) continue;
		if (!source) return false;
		return decision.sourceMessageIds === undefined
			|| decision.suggestedOptionId !== source.optionId
			|| decision.sourceMessageIds.length !== source.messageIds.length
			|| decision.sourceMessageIds.some((id, index) => id !== source.messageIds[index]);
	}
	return true;
}
