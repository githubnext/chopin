import type { Chat as Wire } from "@chopin/protocol";

/** What a Retry runs again, and what it takes out of the transcript. */
export type RetryTarget = {
	/** The member message whose turn failed, which the Retry runs again as it is. */
	request: Wire.Entry & { author: { kind: "member"; handle: string } };
	failure: Wire.TurnFailure;
	/** The failed attempt: its failure notice and every agent entry it wrote, in transcript order. */
	removed: string[];
};

/**
 * The failed turn of `message` that `handle` may run again, or why not. It is the latest Planner
 * turn's failure: no agent entry, Planner message or other failure comes after its notice, so the
 * attempt is the one Chat ends with. Only a turn a person began with a message to the Planner, a
 * failure that asking again can help, and the message's own sender qualify. Everything the agent
 * wrote between the message and the notice is the attempt's own: one turn runs at a time, and
 * what members said meanwhile, and system notices such as an opened decision, stay.
 */
export function retryTarget(
	entries: readonly Wire.Entry[],
	message: string,
	handle: string,
): RetryTarget | { refusal: string } {
	let at = entries.findIndex(entry => entry.id === message);
	let request = entries[at];
	if (!request || request.author.kind !== "member" || request.to !== "planner") {
		return { refusal: "that message has no reply to retry" };
	}
	if (request.author.handle.toLowerCase() !== handle.toLowerCase()) {
		return { refusal: "only the person who sent the message can retry its reply" };
	}
	let notice = entries.findLastIndex(entry => !!entry.turnFailure);
	let failure = entries[notice]?.turnFailure;
	if (!failure || failure.request !== message || notice < at) {
		return { refusal: "that reply did not fail, or another has run since" };
	}
	if (
		entries.slice(notice + 1).some(entry =>
			entry.author.kind === "agent" || entry.author.kind === "member" && entry.to === "planner"
		)
	) return { refusal: "that reply did not fail, or another has run since" };
	if (failure.kind === "refused" || failure.kind === "dropped") {
		return { refusal: "asking again would end the same way" };
	}
	let removed = entries.slice(at + 1, notice).filter(entry => entry.author.kind === "agent")
		.map(entry => entry.id);
	return {
		request: request as RetryTarget["request"],
		failure,
		removed: [...removed, entries[notice]!.id],
	};
}
