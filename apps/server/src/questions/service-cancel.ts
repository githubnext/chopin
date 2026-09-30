import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

// Current-main cancellation API and body retained unchanged.
export async function cancel(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Cancel.Ask>,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	let claimed = Store.claimCancel(plan.questions, msg.id, ws.data.handle);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:cancel", ts: 0, id: msg.id, ...claimed });
	}
	let mutationError: unknown;
	let finish: (() => Store.Ended) | undefined;
	await Service.exclusive(plan, async () => {
		let mutation: room.Mutation | undefined;
		try {
			mutation = room.removeQuestionnaire(plan.document, msg.id);
		} catch (err) {
			mutationError = err;
			return;
		}
		let record = plan.records.get(msg.id);
		if (record) {
			plan.records.set(msg.id, { ...record, status: "cancelled", resolver: ws.data.handle });
		}
		finish = Store.stage(plan.questions, claimed.claim);
		if (mutation) await Service.publish(plan, server, roomId, mutation);
		else await Service.persistExclusive(plan);
	});
	if (mutationError) {
		// The questionnaire stays open and answerable, which is a state every
		// client already renders. Saying "resolving" is honest: the attempt is
		// over, and trying again is the right move.
		console.error("[questions] could not remove the node:", mutationError);
		Store.rollback(plan.questions, claimed.claim);
		return reply(ws, msg.rid, {
			kind: "question:cancel",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "resolving",
		});
	}
	finish!();

	reply(ws, msg.rid, {
		kind: "question:cancel",
		ts: 0,
		id: msg.id,
		ok: true,
		resolver: ws.data.handle,
	});
	broadcast(server, roomId, {
		kind: "question:resolved",
		ts: 0,
		id: msg.id,
		status: "cancelled",
		resolver: ws.data.handle,
	});
}
