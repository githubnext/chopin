import type { Chat as Wire, Session } from "@chopin/protocol";

type Deps = {
	/** Present only under `HARNESS=remote`. */
	attachments?: { status(channelId: string): Session.PlannerAttachment };
	experiments?: {
		plannerMachines: boolean;
		plannerUsed(channelId: string, ask?: boolean): Promise<void>;
		plannerStarting(channelId: string): Promise<unknown>;
	};
};

/**
 * A person asks a machine to start the document's Planner without sending it a message. Only a
 * document with no Planner is asked: one that is attached has nothing to start, and one whose
 * connection dropped, or that another account holds, is resumed by its own machine's client, not
 * by Chopin, so it is left as it is and the answer says why.
 */
export async function wakePlanner(
	channelId: string,
	{ attachments, experiments }: Deps,
): Promise<Pick<Wire.Woke, "asked" | "why">> {
	if (!attachments || !experiments?.plannerMachines) return { asked: false, why: "unavailable" };
	let state = attachments.status(channelId).state;
	if (state === "attached" || state === "disconnected" || state === "held") {
		return { asked: false, why: state };
	}
	await experiments.plannerUsed(channelId, true);
	return await experiments.plannerStarting(channelId)
		? { asked: true }
		: { asked: false, why: "no-machine" };
}
