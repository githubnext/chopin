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

/**
 * Takes one waiting turn out of the queue without telling anyone, so the rest keep their order
 * and a turn that ends now cannot start it. False when it is no longer waiting.
 */
function dequeue(chat: Chat, item: Waiting): boolean {
	if (!chat.waiting.includes(item)) return false;
	chat.waiting = chat.waiting.filter(value => value !== item);
	return true;
}

export function createJobQueue({ queued, report, state, startRun, MAX_QUEUE }: {
	MAX_QUEUE: number;
	/** Tells whoever waits on a turn that will not run that it was skipped. */
	report: (waiting: Waiting, outcome: { status: "skipped" }) => unknown;
	queued: (chat: Chat, server: Server<SocketData>, room: string) => void;
	state: (chat: Chat, server: Server<SocketData>, room: string) => void;
	startRun: (
		context: Room,
		handle: string,
		text: string,
		about: undefined,
		claimantSessionId: string | undefined,
		reserved?: boolean,
		member?: never,
		references?: [],
		jobTurn?: JobTurn,
	) => void;
}) {
	/**
	 * Ends queued work without running it. With no `only` it ends every queued background job, as
	 * archiving and closing a document do. With `only` it ends that one waiting turn, whatever it
	 * is, which is how a person's own queued message leaves the queue: the queue is shown to the
	 * room again and whoever waits on the turn is told it was skipped.
	 */
	function cancelQueuedJobs(context: Announcer, reason: string, only?: Waiting): number {
		let { chat, server, room } = context;
		if (only) {
			dequeue(chat, only);
			if (only.job) finishJob(only.job, { status: "failed", reason: jobReason(reason) });
			else void report(only, { status: "skipped" });
			queued(chat, server, room);
			return 1;
		}
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
		chat.actingChannel = undefined;
		let waiting = chat.waiting;
		chat.waiting = [];
		for (let item of waiting) {
			// A queued comment turn will never run; its thread must stop showing work.
			if (item.ended) {
				void Promise.resolve()
					.then(() => item.ended?.({ status: "failed" }))
					.catch(err => console.error("[chat] a dropped turn's end could not be recorded:", err));
			}
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
		claimantSessionId: string | undefined,
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
		if (chat.busy || chat.starting) {
			if (chat.waiting.length >= MAX_QUEUE) {
				finishJob(turn, {
					status: value.kind === "decision-followup" ? "deferred" : "skipped",
					reason: "The Planner queue is full.",
				});
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
