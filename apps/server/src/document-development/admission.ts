import * as Service from "../plan/service";
import type { DocumentDevelopmentInput } from "./schema";
import { decisionContext, latest, ordinary, snapshot } from "./snapshot";
import * as State from "./state";

export const QUIET_MS = 15_000;
export const INTERVAL_MS = 60_000;
export const WINDOW_MS = 3_600_000;
export const ATTEMPTS = 8;

/** Caller holds the plan's mutation queue; publish only the committed candidate. */
export async function save(plan: Service.Plan, state: State.State): Promise<void> {
	let candidate = { ...plan, documentDevelopment: state };
	await Service.persistExclusive(candidate);
	plan.documentDevelopment = candidate.documentDevelopment;
}

export function fresh(plan: Service.Plan, input: DocumentDevelopmentInput): boolean {
	return latest(plan)?.id === input.messageId
		&& decisionContext(plan).hash === input.decisionHash;
}

export type Admission = { input: DocumentDevelopmentInput; jobId?: string } | { wait: number };

export async function reserve(
	plan: Service.Plan,
	available: () => boolean,
	now: number,
): Promise<Admission | undefined> {
	await Service.drain(plan);
	return Service.exclusive(plan, async () => {
		if (!available() || plan.parentChannelId || plan.documentDevelopment?.paused) return;
		if (Service.implementationActive(plan) || plan.queue.length || plan.chat.busy) {
			return { wait: QUIET_MS };
		}
		let state = State.capture(plan) ?? State.initial();
		let message = latest(plan);
		if (!message || !ordinary(message) || state.lastMessageId === message.id) return;
		if (state.pending?.input.messageId === message.id) return state.pending;
		let quiet = message.ts * 1000 + QUIET_MS - now;
		if (quiet > 0) return { wait: Math.min(quiet, QUIET_MS) };
		let attempts = state.attempts.filter(at => at > now - WINDOW_MS);
		let wait = Math.max(
			0,
			(attempts.at(-1) ?? 0) + INTERVAL_MS - now,
			attempts.length >= ATTEMPTS ? attempts[0]! + WINDOW_MS - now : 0,
		);
		if (wait) return { wait };
		let input = snapshot(plan);
		if (!input) return;
		if (
			(input.capacity.additions === 0 || input.capacity.characters === 0)
			&& !input.passages.some(passage => passage.editable)
		) {
			await save(plan, { ...state, lastMessageId: message.id, lastOutcome: "failed" });
			return;
		}
		let pending = { input };
		await save(plan, { ...state, attempts: [...attempts, now], pending });
		return pending;
	});
}

/** Persist the job link so completion delivery and reopening can recover it. */
export async function link(plan: Service.Plan, input: DocumentDevelopmentInput, jobId: string) {
	await Service.exclusive(plan, async () => {
		let state = plan.documentDevelopment;
		if (
			!state?.pending || JSON.stringify(state.pending.input) !== JSON.stringify(input)
			|| state.pending.jobId === jobId
		) return;
		await save(plan, { ...state, pending: { input, jobId } });
	});
}

/** A stale/terminal attempt is consumed. It cannot run again merely because the document reopens. */
export async function discard(
	plan: Service.Plan,
	messageId: string,
	jobId: string,
	lastOutcome: "failed" | "stale" = "stale",
) {
	await Service.exclusive(plan, async () => {
		let state = plan.documentDevelopment;
		if (!state || state.pending?.input.messageId !== messageId) return;
		let { pending: _pending, ...rest } = state;
		await save(plan, { ...rest, lastMessageId: messageId, lastJobId: jobId, lastOutcome });
	});
}
