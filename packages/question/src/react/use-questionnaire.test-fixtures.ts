import { create, normalize } from "../index";
import type { Transport } from "./use-questionnaire";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 fixture declarations.
export const DEFINITION = normalize({
	questions: [{
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [
			{ label: "Canary", description: "Small percentage first." },
			{ label: "Blue-green", description: "" },
		],
	}],
});

export const MULTI_QUESTIONNAIRE = normalize({
	questions: [
		{
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [{ label: "Canary", description: "Small percentage first." }],
		},
		{
			header: "Timing",
			question: "When should we deploy?",
			multiple: false,
			options: [{ label: "Tomorrow", description: "" }],
		},
	],
});

export const QUESTIONNAIRE = {
	questions: MULTI_QUESTIONNAIRE.questions.map((question, index) => ({
		...question,
		options: question.options.map(option => ({ ...option, id: `o${index}` })),
	})),
};

export function transport(definition = DEFINITION) {
	let opens = 0;
	let edits = 0;
	let submits = 0;
	let discards: string[] = [];
	let submitIds: string[] = [];
	let submitRevisions: number[] = [];
	let submitPayloads: Record<string, unknown>[] = [];
	let currentRevision = 0;
	let currentSuggestion: { optionId: string; revision: number } | undefined;
	let presence = 0;
	let handlers = new Map<string, Set<(event: never) => void>>();
	let model = create(definition);

	let value = {
		async ask(kind: string, payload: Record<string, unknown>) {
			if (kind === "question:open") {
				opens++;
				return {
					open: true,
					definition,
					model: [...model.toBinary()],
					revision: currentRevision,
					presence: [],
				};
			}
			if (kind === "question:edit") {
				edits++;
				return { open: true, accepted: true, applied: false, revision: ++currentRevision };
			}
			if (kind === "question:submit") {
				submits++;
				submitIds.push(payload.id as string);
				submitRevisions.push(payload.revision as number);
				submitPayloads.push({ ...payload });
				if (
					payload.suggestedOptionId !== undefined && (
						payload.revision !== currentRevision
						|| payload.suggestedOptionId !== currentSuggestion?.optionId
					)
				) return { ok: false, reason: "stale", current: currentRevision };
				return { ok: true };
			}
			if (kind === "question:discard") {
				discards.push(payload.id as string);
				return { ok: true };
			}
			throw new Error(`Unexpected ${kind}`);
		},
		send(kind: string) {
			if (kind === "question:presence") presence++;
		},
		on(kind: string, handler: (event: never) => void) {
			let set = handlers.get(kind);
			if (!set) handlers.set(kind, set = new Set());
			set.add(handler);
			return () => set.delete(handler);
		},
	} as unknown as Transport;

	return {
		value,
		opens: () => opens,
		edits: () => edits,
		submits: () => submits,
		discards: () => discards,
		submitIds: () => submitIds,
		submitRevisions: () => submitRevisions,
		submitPayloads: () => submitPayloads,
		setSuggestion: (suggestion: { optionId: string; revision: number } | undefined) => {
			currentSuggestion = suggestion;
			currentRevision = suggestion?.revision ?? currentRevision + 1;
		},
		presence: () => presence,
	};
}
