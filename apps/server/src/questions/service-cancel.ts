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
	let result: Awaited<ReturnType<typeof withdraw>>;
	let acknowledged = false;
	try {
		result = await withdraw(plan, server, roomId, msg.id, ws.data.handle, () => {
			acknowledged = true;
			reply(ws, msg.rid, {
				kind: "question:cancel",
				ts: 0,
				id: msg.id,
				ok: true,
				resolver: ws.data.handle,
			});
		});
	} catch (failure) {
		return fail(
			ws,
			msg.rid,
			failure instanceof ConversationCapacityError
				|| failure instanceof Error && failure.message === "implementation is active"
				? failure.message
				: "could not cancel the questionnaire",
		);
	}
	if (!acknowledged) reply(ws, msg.rid, { kind: "question:cancel", ts: 0, id: msg.id, ...result });
}

/**
 * Withdraw input on behalf of a member or the Planner, after its durable commit.
 * `acknowledge` runs first once the withdrawal is committed, before it is announced.
 */
export async function withdraw(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	resolver: string,
	acknowledge?: () => void,
): Promise<Store.CancelRefusal | { ok: true; resolver: string }> {
	let claimed = Store.claimCancel(plan.questions, id, resolver);
	if (!claimed.ok) return claimed;
	let mutationError: unknown;
	let failure: unknown;
	let finish: (() => Store.Ended) | undefined;
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			if (plan.questions.open.get(id) !== claimed.claim.entry) {
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
					mutation = room.removeQuestionnaire(document, id);
				} catch (err) {
					mutationError = err;
					return;
				}
				let record = plan.records.get(id);
				let records = new Map(plan.records);
				if (record) {
					records.set(id, { ...record, status: "cancelled", resolver });
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
							id,
							actor: resolver,
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
	if (failure) throw failure;
	if (mutationError) {
		console.error("[questions] could not remove the node:", mutationError);
		return { ok: false, reason: "resolving" };
	}
	if (!finish) throw new Error("could not cancel the questionnaire");
	finish();
	let record = plan.records.get(id);
	for (
		let notify of [
			...(acknowledge ? [acknowledge] : []),
			() =>
				broadcast(server, roomId, {
					kind: "question:resolved",
					ts: 0,
					id,
					status: "cancelled",
					resolver,
				}),
			() => announce(plan, server, roomId, id),
			() =>
				emit(plan, {
					kind: "discarded",
					id,
					...(record?.threadId ? { threadId: record.threadId } : {}),
					actor: resolver,
				}),
		]
	) {
		try {
			notify();
		} catch (err) {
			console.error("[questions] could not announce a cancelled questionnaire:", err);
		}
	}
	return { ok: true, resolver };
}
