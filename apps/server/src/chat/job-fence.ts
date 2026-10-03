import { jobReason, type JobTurn } from "./job-queue";
import type { Chat } from "./service";

/** A cancelled current turn must lose its tool's live job identity before any late write. */
export function watchJobAbort(chat: Chat, turn: JobTurn, signal: AbortSignal): () => void {
	let currentTurn = chat.turn;
	function abort() {
		if (chat.job !== turn.job || chat.turn !== currentTurn) return;
		chat.job = undefined;
		chat.jobOutput = undefined;
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
