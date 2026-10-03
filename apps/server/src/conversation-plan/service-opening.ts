import * as Chat from "../chat/service";
import * as Comments from "../comments/service";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { tell } from "../wire";

import type { Plan as Wire, Request } from "@chopin/protocol";
import type { Socket } from "../wire";
import type { Room } from "../rooms";

type OpeningRoom<P> = { plan?: P; opening?: Promise<P> };

/** Complete all setup before exposing a plan to concurrent socket frames. */
export async function publishOpenedPlan<P>(
	room: OpeningRoom<P>,
	opened: P,
	prepare: () => Promise<void> | void,
): Promise<P> {
	await prepare();
	room.plan = opened;
	return opened;
}

/** Preparation owns an unpublished document until close intent has been checked. */
export async function prepareOpenedPlan(
	room: Room,
	opened: Service.Plan,
	prepare: () => Promise<void> | void,
): Promise<Service.Plan> {
	try {
		if (room.closing) throw new Error("document is unavailable");
		await prepare();
		if (room.closing) throw new Error("document is unavailable");
		room.plan = opened;
		return opened;
	} catch (error) {
		try {
			await Service.abortOpening(opened);
		} catch (cleanupError) {
			let failure = new AggregateError(
				[error, cleanupError],
				"document preparation and cleanup failed",
				{
					cause: cleanupError,
				},
			);
			throw failure;
		}
		throw error;
	}
}

/** A chat send racing first open must wait for processor attachment. */
export async function readyPlan<P>(room: OpeningRoom<P>): Promise<P | undefined> {
	if (room.opening) await room.opening;
	return room.plan;
}

/** An archive that failed early still has to observe a concurrent first open. */
export async function recoverOpenedPlan<P>(
	room: OpeningRoom<P> | undefined,
): Promise<P | undefined> {
	if (!room) return undefined;
	if (!room.plan) {
		try {
			await room.opening;
		} catch {
			// A failed open left no plan or job coordinator to reattach.
		}
	}
	return room.plan;
}

/** Read the transcript and prototype together after all earlier commits settle. */
export function greetJoinedPlan(
	opened: Service.Plan,
	ws: Socket,
	frame: Request<Wire.Open.Ask>,
	conversationPlan: boolean,
	current: () => boolean,
): Promise<void> {
	return Service.exclusive(opened, async () => {
		if (!current()) throw new Error("document is unavailable");
		Service.greet(opened, ws, frame);
		Questions.greet(opened, ws);
		Comments.greet(opened, ws);
		Chat.greet(opened.chat, ws);
		if (conversationPlan) {
			tell(ws, {
				kind: "conversation-plan:snapshot",
				ts: 0,
				state: opened.conversationPlan,
				jobs: opened.conversationPlanJobs,
			});
		}
	});
}

/** Recovery must also settle an attachment after the plan has been published. */
export async function recoverAttachedPlan<P>(
	room: OpeningRoom<P> | undefined,
): Promise<P | undefined> {
	if (room?.opening) {
		try {
			await room.opening;
		} catch {
			// A failed first open must not replace the archive outcome.
		}
	}
	return recoverOpenedPlan(room);
}
