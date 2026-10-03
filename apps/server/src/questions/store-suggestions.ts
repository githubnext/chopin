import * as Question from "@chopin/question";

import type { Draft } from "@chopin/question";
import type { Questions } from "./store-types";

export function untouched(draft: Draft): boolean {
	return draft.mode === "choices" && draft.choice === null && draft.custom.length === 0
		&& !Object.values(draft.options).some(Boolean);
}

/** Persist or clear an advisory conversation option without editing the shared draft. */
export function suggest(
	questions: Questions,
	id: string,
	suggestion?: { optionId: string; messageIds: string[] },
): { ok: true; patch: number[]; revision: number } | {
	ok: false;
	reason: "closed" | "chosen" | "unknown";
} {
	let entry = questions.open.get(id);
	if (!entry || entry.claim) return { ok: false, reason: "closed" };
	if (!suggestion) {
		if (!entry.suggested) return { ok: true, patch: [], revision: entry.revision };
		entry.revision++;
		entry.suggested = undefined;
		return { ok: true, patch: [], revision: entry.revision };
	}
	let question = entry.definition.questions[0];
	if (
		entry.definition.questions.length !== 1 || !question || question.multiple
		|| !question.options.some(option => option.id === suggestion.optionId)
		|| !Array.isArray(suggestion.messageIds) || suggestion.messageIds.length > 16
		|| suggestion.messageIds.some(id => typeof id !== "string" || !id || id.length > 200)
		|| new Set(suggestion.messageIds).size !== suggestion.messageIds.length
	) return { ok: false, reason: "unknown" };
	let draft = Question.read(entry.model, entry.definition)[question.id]!;
	if (!untouched(draft)) return { ok: false, reason: "chosen" };
	if (
		entry.suggested?.optionId === suggestion.optionId
		&& entry.suggested.messageIds.length === suggestion.messageIds.length
		&& entry.suggested.messageIds.every((id, index) => id === suggestion.messageIds[index])
	) return { ok: true, patch: [], revision: entry.revision };
	entry.revision++;
	entry.suggested = {
		optionId: suggestion.optionId,
		messageIds: [...suggestion.messageIds],
		revision: entry.revision,
	};
	return { ok: true, patch: [], revision: entry.revision };
}
