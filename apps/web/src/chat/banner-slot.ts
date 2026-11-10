import type { ConnectionView } from "./connection-phase";

/**
 * What the composer's banner slot holds: one banner for each cause, never two for one.
 *
 * The room's socket and the document's sync are the cause of anything the connection cut off, so
 * their banner is the whole slot and a refused send or a failed reply waits behind it. A Planner
 * that is away or absent is another fact: it shows beside a message the server refused or a reply
 * that failed, which it did not cause. The one exception is a machine that dropped (held or
 * disconnected), whose banner already tells why a reply failed.
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
): BannerSlot {
	let shown = view && view.phase !== "online" ? view : undefined;
	if (shown && shown.layer !== "planner") return { connection: true, quietsNotices: true };
	let kind = shown && "plannerKind" in shown ? shown.plannerKind : undefined;
	let machineDropped = kind === "held" || kind === "disconnected";
	let lead: BannerSlot["lead"] = send ? "send" : failure && !machineDropped ? "failure" : undefined;
	return { ...(lead ? { lead } : {}), connection: !!shown, quietsNotices: !!lead };
}
