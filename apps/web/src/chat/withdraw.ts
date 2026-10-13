import type { Chat as Wire } from "@chopin/protocol";

/** Only the actor who queued a message may withdraw it, whoever else shares the room. */
export function canWithdraw(
	queue: readonly Pick<Wire.Waiting, "id" | "handle">[],
	id: string,
	handle: string,
): boolean {
	return queue.some(item => item.id === id && item.handle === handle);
}
