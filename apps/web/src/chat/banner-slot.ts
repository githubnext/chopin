import type { ConnectionView } from "./connection-phase";

/**
 * What the composer's banner slot holds: one banner for each cause, never two for one.
 *
 * The room's socket and the document's sync are the cause of anything the connection cut off, so
 * their banner is the whole slot and a refused send or a failed reply waits behind it. A Planner
 * that is away or absent is another fact: it shows beside a message the server refused or a reply
 * that failed, which it did not cause. The one exception is a reply that failed as its machine
 * dropped (held or disconnected): the machine's banner tells why, and a retry cannot reach it, so
 * that reply's own line stays in the transcript until its banner is drawn. A reply whose failure
 * was already shown (`shown`) before the machine dropped failed for another cause, and keeps its
 * banner and Retry beside the machine's. Where the composer is not
 * drawn (an archived or read-only document) there is no slot, and nothing leaves the transcript.
 */
export type BannerSlot = {
	/** The refused send or the failed reply, shown above the connection banner. */
	lead?: "send" | "failure";
	/** The connection banner is drawn. */
	connection: boolean;
	/** The composer's other notices (research, replies off) give way to the slot. */
	quietsNotices: boolean;
};

export function bannerSlot(
	view: ConnectionView | undefined,
	send: boolean,
	failure: boolean,
	composer = true,
	shown = false,
): BannerSlot {
	if (!composer) return { connection: false, quietsNotices: false };
	let told = view && view.phase !== "online" ? view : undefined;
	if (told && told.layer !== "planner") return { connection: true, quietsNotices: true };
	let kind = told && "plannerKind" in told ? told.plannerKind : undefined;
	let droppedWithIt = (kind === "held" || kind === "disconnected") && !shown;
	let lead: BannerSlot["lead"] = send ? "send" : failure && !droppedWithIt ? "failure" : undefined;
	return { ...(lead ? { lead } : {}), connection: !!told, quietsNotices: !!lead };
}
