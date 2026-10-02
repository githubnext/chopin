import * as Y from "yjs";
import { ConversationCapacityError } from "../conversation-plan/events";
import * as room from "../plan/room";
import * as Store from "./store";
import { announce, emit, pending } from "./card-notifications";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

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
	let failure: unknown;
	let finish: (() => Store.Ended) | undefined;
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			if (plan.questions.open.get(msg.id) !== claimed.claim.entry) {
				throw new Error("questionnaire is no longer open");
			}
			let document = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			document.seq = plan.document.seq;
			try {
				let mutation: room.Mutation | undefined;
				try {
					mutation = room.removeQuestionnaire(document, msg.id);
				} catch (err) {
					mutationError = err;
					return;
				}
				let record = plan.records.get(msg.id);
				let records = new Map(plan.records);
				if (record) {
					records.set(msg.id, { ...record, status: "cancelled", resolver: ws.data.handle });
				}
				let questions: Store.Questions = {
					open: new Map(plan.questions.open),
					closed: new Map(plan.questions.closed),
				};
				let complete = Store.stage(questions, claimed.claim);
				await Service.publishStaged(plan, server, roomId, {
					...plan,
					document,
					questions,
					records,
					pendingCardActions: record
						? pending(plan, record, {
							kind: "discarded",
							id: msg.id,
							actor: ws.data.handle,
						})
						: plan.pendingCardActions,
				}, mutation);
				finish = complete;
			} finally {
				document.doc.destroy();
			}
		});
	} catch (err) {
		failure = err;
	}
	if (!finish) Store.rollback(plan.questions, claimed.claim);
	if (failure) {
		return fail(
			ws,
			msg.rid,
			failure instanceof ConversationCapacityError
				|| failure instanceof Error && failure.message === "implementation is active"
				? failure.message
				: "could not cancel the questionnaire",
		);
	}
	if (mutationError) {
		console.error("[questions] could not remove the node:", mutationError);
		return reply(ws, msg.rid, {
			kind: "question:cancel",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "resolving",
		});
	}
	if (!finish) return fail(ws, msg.rid, "could not cancel the questionnaire");
	finish();
	let record = plan.records.get(msg.id);
	for (
		let notify of [
			() =>
				reply(ws, msg.rid, {
					kind: "question:cancel",
					ts: 0,
					id: msg.id,
					ok: true,
					resolver: ws.data.handle,
				}),
			() =>
				broadcast(server, roomId, {
					kind: "question:resolved",
					ts: 0,
					id: msg.id,
					status: "cancelled",
					resolver: ws.data.handle,
				}),
			() => announce(plan, server, roomId, msg.id),
			() =>
				emit(plan, {
					kind: "discarded",
					id: msg.id,
					...(record?.threadId ? { threadId: record.threadId } : {}),
					actor: ws.data.handle,
				}),
		]
	) {
		try {
			notify();
		} catch (err) {
			console.error("[questions] could not announce a cancelled questionnaire:", err);
		}
	}
}
