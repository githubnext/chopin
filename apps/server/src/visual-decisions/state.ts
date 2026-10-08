import { Visual } from "@chopin/question";
import type { VisualDecision } from "@chopin/protocol";
import type { Questionnaire } from "@chopin/dialect";
import { ULID } from "@chopin/dialect";

export type Stored = VisualDecision.State & {
	questionId: string;
	createKey?: string;
	edits: Record<string, number>;
};
export type Decisions = Map<string, Stored>;
export const MAX_CLIENTS = 512;
export const MAX_DECISIONS = 20;

export function createKey(raw: unknown): string {
	if (
		typeof raw !== "string"
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)
	) throw new Error("Invalid visual creation key");
	return raw;
}

export function editKey(raw: unknown): { client: string; sequence: number } {
	if (typeof raw !== "string") throw new Error("Invalid visual edit key");
	let match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]{0,15})$/
		.exec(raw);
	if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid visual edit key");
	return { client: match[1]!, sequence: Number(match[2]) };
}

export function snapshot(stored: Stored): VisualDecision.State {
	let { edits: _edits, questionId: _questionId, createKey: _createKey, ...state } = stored;
	return state;
}

export function dump(decisions: Decisions): Stored[] {
	return [...decisions.values()];
}

export function restore(raw: unknown): Decisions {
	if (raw === undefined) return new Map();
	if (!Array.isArray(raw) || raw.length > MAX_DECISIONS) {
		throw new Error("Invalid visual decisions");
	}
	let decisions: Decisions = new Map();
	let creationKeys = new Set<string>();
	for (let entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("Invalid visual decision");
		}
		let { edits, questionId, createKey: key, ...candidate } = entry;
		let state = Visual.state(candidate);
		if (Object.hasOwn(entry, "createKey")) {
			createKey(key);
			if (creationKeys.has(key)) throw new Error("Duplicate visual creation key");
			creationKeys.add(key);
		}
		if (
			decisions.has(state.id) || typeof questionId !== "string" || !ULID.test(questionId)
			|| !edits || typeof edits !== "object" || Array.isArray(edits)
			|| Object.keys(edits).length > MAX_CLIENTS
		) throw new Error("Invalid visual edit history");
		for (let [client, sequence] of Object.entries(edits)) {
			if (typeof sequence !== "number") throw new Error("Invalid visual edit history");
			editKey(`${client}:${sequence}`);
		}
		decisions.set(state.id, {
			...state,
			questionId,
			edits,
			...(key === undefined ? {} : { createKey: key }),
		});
	}
	return decisions;
}

export function validateProjections(decisions: Decisions, projections: Questionnaire[]): void {
	let marked = projections.filter(value => value.visual !== undefined);
	if (marked.length !== decisions.size) {
		throw new Error("Visual decision projections disagree with records");
	}
	for (let record of decisions.values()) {
		let matches = marked.filter(value => value.id === record.id);
		let value = matches[0];
		let question = value?.questions[0];
		if (
			matches.length !== 1 || value?.visual !== record.definition.specimen || !question
			|| value.questions.length !== 1 || question.id !== record.questionId
			|| (record.saved
				? value.status !== "decided" || value.by !== record.saved.by
					|| value.at !== record.saved.at || question.answer !== Visual.summary(record.saved.values)
				: value.status !== "open" || value.by !== undefined || value.at !== undefined
					|| question.answer !== undefined)
		) {
			throw new Error("Visual decision projections disagree with records");
		}
	}
}
