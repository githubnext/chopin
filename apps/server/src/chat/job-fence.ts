import { jobReason, type JobTurn } from "./job-queue";
import type { Chat } from "./service";

/** A cancelled current turn must lose its tool's live job identity before any late write. */
export function watchJobAbort(chat: Chat, turn: JobTurn, signal: AbortSignal): () => void {
	let currentTurn = chat.turn;
	function abort() {
		if (chat.job !== turn.job || chat.turn !== currentTurn) return;
		// A job that gave way to a person keeps what its own tool wrote, and was not interrupted.
		if (turn.preempted) turn.output = chat.jobOutput;
		chat.job = undefined;
		chat.jobOutput = undefined;
		if (turn.preempted) return;
		chat.interruption ??= chat.closed
			? "The document closed."
			: signal.reason instanceof Error && signal.reason.name !== "AbortError"
			? jobReason(signal.reason)
			: "The Planner turn was stopped.";
	}
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	return () => signal.removeEventListener("abort", abort);
}
