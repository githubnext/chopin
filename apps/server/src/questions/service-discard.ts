import * as Y from "yjs";

import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

import { announce, emit, pending } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export type DiscardResult =
	| { ok: true; resolver: string }
	| { ok: false; reason: "resolving" }
	| { ok: false; reason: "resolved"; status: "discarded"; resolver: string };

export async function discard(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Discard.Ask>,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	let respond = (body: DiscardResult) =>
		reply(ws, msg.rid, { kind: "question:discard", ts: 0, id: msg.id, ...body });
	let result: DiscardResult | undefined;
	let failure: unknown;
	let finish: (() => Store.Ended) | undefined;
	let live = false;
	let threadId: string | undefined;
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			let record = plan.records.get(msg.id);
			if (!record || record.status === "discarded" || record.status === "cancelled") {
				result = {
					ok: false,
					reason: "resolved",
					status: "discarded",
					resolver: record?.resolver ?? "system",
				};
				return;
			}
			live = isOpenStatus(record.status);
			threadId = record.threadId;
			let stagedQuestions: Store.Questions = {
				open: new Map(plan.questions.open),
				closed: new Map(plan.questions.closed),
			};
			let complete: (() => Store.Ended) | undefined;
			if (live) {
				let entry = stagedQuestions.open.get(msg.id);
				if (entry) {
					stagedQuestions.open.set(msg.id, {
						...entry,
						editors: new Set(entry.editors),
					});
				}
				let claimed = Store.claimCancel(stagedQuestions, msg.id, ws.data.handle);
				if (!claimed.ok) {
					result = claimed.reason === "resolving"
						? { ok: false, reason: "resolving" }
						: {
							ok: false,
							reason: "resolved",
							status: "discarded",
							resolver: claimed.resolver,
						};
					return;
				}
				complete = Store.stage(stagedQuestions, claimed.claim);
			}
			let stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			try {
				let mutation = room.projectCard(stagedDocument, msg.id, { status: "discarded" });
				let records = new Map(plan.records);
				records.set(msg.id, { ...record, status: "discarded", resolver: ws.data.handle });
				await Service.publishStaged(plan, server, roomId, {
					...plan,
					document: stagedDocument,
					questions: stagedQuestions,
					records,
					pendingCardActions: pending(plan, record, {
						kind: "discarded",
						id: msg.id,
						actor: ws.data.handle,
					}),
				}, mutation);
				finish = complete;
				result = { ok: true, resolver: ws.data.handle };
			} finally {
				stagedDocument.doc.destroy();
			}
		});
	} catch (err) {
		failure = err;
	}
	if (failure) {
		if (failure instanceof Error && failure.message === "implementation is active") {
			return fail(ws, msg.rid, failure.message);
		}
		console.error("[questions] could not discard the card:", failure);
		return respond({ ok: false, reason: "resolving" });
	}
	if (!result) return respond({ ok: false, reason: "resolving" });
	if (!result.ok) return respond(result);
	finish?.();
	respond(result);
	if (live) {
		broadcast(server, roomId, {
			kind: "question:resolved",
			ts: 0,
			id: msg.id,
			status: "cancelled",
			resolver: ws.data.handle,
		});
	}
	announce(plan, server, roomId, msg.id);
	emit(plan, {
		kind: "discarded",
		id: msg.id,
		...(threadId ? { threadId } : {}),
		actor: ws.data.handle,
	});
}
