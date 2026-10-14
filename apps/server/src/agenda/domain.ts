import { z } from "zod";
import type { Agenda } from "@chopin/protocol";
import type { AgendaOwner, AgendaRecord } from "../storage/agenda";

export const AGENDA_LIMITS: Agenda.Limits = Object.freeze({
	maxQuestions: 6,
	maxInvestigations: 3,
	maxAiCredits: 420,
	maxAssessments: 5,
	minIntervalMs: 5 * 60_000,
	durationMs: 24 * 60 * 60_000,
	requestTimeoutMs: 15 * 60_000,
});
export const MODEL_CREDITS = 30;
export const MODEL_TIMEOUT_MS = 60_000;
export const questionSchema = z.object({
	question: z.string().trim().min(8).max(500),
	reason: z.string().trim().min(1).max(300),
	evidenceNeed: z.string().trim().min(1).max(500),
	priority: z.number().int().min(1).max(3),
}).strict();
export const saveSchema = z.object({
	expectedRevision: z.number().int().min(0),
	scope: z.string().trim().min(20).max(2000),
	questions: z.array(questionSchema).max(AGENDA_LIMITS.maxQuestions),
}).strict();
export const assessmentSchema = z.object({
	decision: z.enum(["investigate", "sufficient", "stop"]),
	questionId: z.string().max(100),
	/** Private rationale is retained only in the isolated result, never a public query. */
	reason: z.string().min(1).max(500),
}).strict();
export type Assessment = z.infer<typeof assessmentSchema>;

export class AgendaError extends Error {
	constructor(readonly code: "invalid" | "conflict" | "unavailable", message: string) {
		super(message);
		this.name = "AgendaError";
	}
}

export function normalizedQuestion(value: string): string {
	return value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Conservative lexical deduplication supplements the scope-only model's semantic deduplication. */
export function uniqueQuestions(input: Agenda.QuestionInput[]): Agenda.QuestionInput[] {
	let retained: Agenda.QuestionInput[] = [];
	for (let question of input) {
		let key = normalizedQuestion(question.question);
		let words = new Set(key.split(" "));
		let duplicate = retained.some(prior => {
			let other = normalizedQuestion(prior.question);
			if (other === key) return true;
			let tokens = new Set(other.split(" "));
			let overlap = [...words].filter(word => tokens.has(word)).length;
			return words.size >= 6 && tokens.size >= 6
				&& overlap / new Set([...words, ...tokens]).size > 0.85;
		});
		if (!duplicate) retained.push(question);
	}
	return retained;
}

export function sameOwner(left: AgendaOwner, right: AgendaOwner): boolean {
	return left.userId === right.userId && left.sessionId === right.sessionId
		&& left.generation === right.generation
		&& left.credentialRevision === right.credentialRevision;
}

export function runnable(record: AgendaRecord, now: Date): boolean {
	return record.state === "active" && !!record.owner && !!record.expiresAt
		&& Date.parse(record.expiresAt) > now.getTime();
}

export function publicBrief(scope: string, question: Agenda.QuestionInput): string {
	return `${scope}\n\nQuestion: ${question.question}\nEvidence needed: ${question.evidenceNeed}`;
}
