import { ulid } from "@chopin/dialect";
import type { ConversationPlan } from "@chopin/protocol";
import type { Server } from "bun";
import type { SocketData } from "../wire";
import type { JobOutcome } from "../conversation-plan/jobs";
import type { Announcer } from "./notices";
import type { Chat, Room, Waiting } from "./service";

export type JobTurn = {
	job: ConversationPlan.Job;
	prompt: string;
	done: (outcome: JobOutcome) => void;
	settled?: boolean;
};

export function jobReason(error: unknown): string {
	let message = error instanceof Error ? error.message : String(error);
	return message.trim().slice(0, 500) || "The Planner could not be reached.";
}

export function finishJob(turn: JobTurn, outcome: JobOutcome): void {
	if (turn.settled) return;
	turn.settled = true;
	turn.done(outcome);
}

export function safeProjection<Args extends unknown[]>(project: (...args: Args) => void) {
	return (...args: Args): void => {
		try {
			project(...args);
		} catch (error) {
			console.error("[chat] could not broadcast background job state:", error);
		}
	};
}

export function createJobQueue({ queued, state, startRun, MAX_QUEUE }: {
	MAX_QUEUE: number;
	queued: (chat: Chat, server: Server<SocketData>, room: string) => void;
	state: (chat: Chat, server: Server<SocketData>, room: string) => void;
	startRun: (
		context: Room,
		handle: string,
		text: string,
		thread: string | undefined,
		claimantSessionId: string,
		reserved?: boolean,
		member?: never,
		references?: [],
		jobTurn?: JobTurn,
	) => void;
}) {
	function cancelQueuedJobs(context: Announcer, reason: string): number {
		let { chat, server, room } = context;
		let retained: Waiting[] = [];
		let cancelled = 0;
		for (let waiting of chat.waiting) {
			if (!waiting.job) {
				retained.push(waiting);
				continue;
			}
			cancelled++;
			finishJob(waiting.job, { status: "failed", reason: jobReason(reason) });
		}
		if (chat.handoffJob && !chat.handoffJob.settled) {
			cancelled++;
			finishJob(chat.handoffJob, { status: "failed", reason: jobReason(reason) });
		}
		if (cancelled > 0) {
			chat.waiting = retained;
			queued(chat, server, room);
		}
		return cancelled;
	}

	function stopAfterPersistenceFailure(chat: Chat, server: Server<SocketData>, room: string): void {
		chat.closed = true;
		chat.busy = false;
		chat.turn = undefined;
		chat.acting = undefined;
		let waiting = chat.waiting;
		chat.waiting = [];
		for (let item of waiting) {
			if (item.job) {
				finishJob(item.job, {
					status: "failed",
					reason: "The Planner turn could not be saved.",
				});
			}
		}
		queued(chat, server, room);
		state(chat, server, room);
	}

	function job(
		context: Room,
		value: ConversationPlan.Job,
		prompt: string,
		claimantSessionId: string,
		signal?: AbortSignal,
	): Promise<JobOutcome> {
		let { chat, config, room, server } = context;
		if (!config.agent) {
			return Promise.resolve({ status: "skipped", reason: "The Planner is off (AGENT=off)." });
		}
		if (chat.closed) return Promise.resolve({ status: "failed", reason: "The document closed." });
		let cancelled: JobOutcome = { status: "failed", reason: "The Planner job was cancelled." };
		if (signal?.aborted) return Promise.resolve(cancelled);
		let { promise, resolve } = Promise.withResolvers<JobOutcome>();
		let turn: JobTurn = {
			job: value,
			prompt,
			done: outcome => {
				signal?.removeEventListener("abort", cancel);
				resolve(outcome);
			},
		};
		function cancel() {
			if (turn.settled) return;
			if (chat.job === value) {
				chat.interruption = "The Planner job was cancelled.";
				chat.job = undefined;
				chat.jobOutput = undefined;
				chat.turnController?.abort();
				return;
			}
			chat.waiting = chat.waiting.filter(item => item.job !== turn);
			finishJob(turn, cancelled);
			queued(chat, server, room);
		}
		signal?.addEventListener("abort", cancel, { once: true });
		if (chat.busy) {
			if (chat.waiting.length >= MAX_QUEUE) {
				finishJob(turn, { status: "skipped", reason: "The Planner queue is full." });
				return promise;
			}
			chat.waiting.push({
				id: ulid(),
				handle: "chopin",
				text: "(background job)",
				sessionId: claimantSessionId,
				job: turn,
			});
			queued(chat, server, room);
		} else {
			startRun(context, "chopin", prompt, undefined, claimantSessionId, false, undefined, [], turn);
		}
		return promise;
	}

	return { job, cancelQueuedJobs, stopAfterPersistenceFailure };
}
