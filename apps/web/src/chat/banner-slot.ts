import { offlineBar } from "./connection-phase";
import type { ConnectionView } from "./connection-phase";

/**
 * What the composer's banner slot holds: a refused send or a failed reply, one at a time.
 *
 * The connection is never drawn here: the room's socket lost for a while is the offline bar over
 * the transcript, and the Planner's machine is presence on the machine button and on chopin. While
 * the offline bar shows, the connection is the cause of anything it cut off, so a refused send or a
 * failed reply waits behind it and the composer's other notices give way. Otherwise a refused send
 * comes first, then a failed reply. Where the composer is not drawn (an archived or read-only
 * document) there is no slot, and nothing leaves the transcript.
 */
export type BannerSlot = {
	/** The refused send or the failed reply, shown above the composer. */
	lead?: "send" | "failure";
	/** The composer's other notices (research, replies off) give way to the slot. */
	quietsNotices: boolean;
};

export function bannerSlot(
	view: ConnectionView | undefined,
	send: boolean,
	failure: boolean,
	composer = true,
): BannerSlot {
	if (!composer) return { quietsNotices: false };
	if (view && offlineBar(view)) return { quietsNotices: true };
	let lead: BannerSlot["lead"] = send ? "send" : failure ? "failure" : undefined;
	return { ...(lead ? { lead } : {}), quietsNotices: !!lead };
}
