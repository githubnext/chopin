import type { ServerWebSocket } from "bun";

import type { Chat as Wire, Session } from "@chopin/protocol";

import { fail, PASSING, reply } from "../wire";

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

/**
 * Answer a `chat:wake` frame. `writable` is the check `chat:send` to the Planner makes (write
 * access, the document not archived or deleted, the socket still in its room); a refusal has
 * already been answered, so nothing is asked of any machine. A child has no Chat: its root's does.
 */
export async function answerWake(
	ws: Pick<ServerWebSocket<unknown>, "send">,
	rid: string,
	room: { id: string; parentChannelId?: string | null },
	writable: () => Promise<boolean>,
	deps: Deps,
): Promise<void> {
	try {
		if (!await writable()) return;
		if (room.parentChannelId) {
			fail(ws, rid, "this document's Chat is on its root document");
			return;
		}
		reply(ws, rid, { kind: "chat:wake", ts: 0, ...await wakePlanner(room.id, deps) });
	} catch (error) {
		fail(ws, rid, error instanceof Error ? error.message : "cannot ask for the Planner", PASSING);
	}
}
