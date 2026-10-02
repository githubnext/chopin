import { rebase } from "./service-relationships";
import { parse } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";
import { ConversationCapacityError } from "../conversation-plan/events";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

import type { Record } from "./records";

import { announce, emit, pending } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export type ReopenResult =
	| { ok: true }
	| { ok: false; reason: "not-decided" | "resolving" };

export async function reopen(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Reopen.Ask>,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	let respond = (body: { ok: true } | { ok: false; reason: "not-decided" | "resolving" }) =>
		reply(ws, msg.rid, { kind: "question:reopen", ts: 0, id: msg.id, ...body });
	let result: ReopenResult | undefined;
	let failure: unknown;
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			let record = plan.records.get(msg.id);
			if (!record || record.status !== "answered") {
				result = { ok: false, reason: "not-decided" };
				return;
			}
			let selected = new Set(record.choices ?? []);
			let known = new Set(
				record.definition.questions.flatMap(question => question.options.map(option => option.id)),
			);
			if (
				[...selected].some(id => !known.has(id))
				|| selected.size !== (record.choices ?? []).length
			) {
				result = { ok: false, reason: "resolving" };
				return;
			}
			let owner = record.owner ?? record.resolver ?? "unknown";
			let at = record.decidedAt ?? record.at ?? Math.floor(Date.now() / 1_000);
			let previous: room.CardChange["previous"] = {};
			let text: { [question: string]: string } = {};
			for (let question of record.definition.questions) {
				let ids = question.options.filter(option => selected.has(option.id)).map(option =>
					option.id
				);
				if (ids.length > (question.multiple ? Question.limits.MAX_OPTIONS : 1)) {
					result = { ok: false, reason: "resolving" };
					return;
				}
				if (ids.length) {
					previous[question.id] = {
						choices: ids,
						by: owner,
						at: new Date(at * 1_000).toISOString(),
					};
				} else {
					let answer = record.answers?.[question.id];
					if (
						typeof answer !== "string" || !answer.trim()
						|| answer.length > Question.limits.MAX_CUSTOM
					) {
						result = { ok: false, reason: "resolving" };
						return;
					}
					text[question.id] = answer;
					previous[question.id] = {
						choices: [],
						value: answer,
						by: owner,
						at: new Date(at * 1_000).toISOString(),
					};
				}
			}
			let stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			try {
				let vector = Y.encodeStateVector(stagedDocument.doc);
				let previousSource = room.project(stagedDocument);
				let candidate: Plan = {
					...plan,
					document: stagedDocument,
					records: new Map(plan.records),
				};
				// Rebase on the staged document so a moved paragraph is found by its
				// current live anchor, without changing the live sidecar before commit.
				rebase(candidate);
				room.projectCard(stagedDocument, msg.id, {
					status: "reopened",
					clearAnswers: true,
					previous,
				});
				let prose = candidate.records.get(msg.id)?.prose?.filter(anchor => !anchor.orphaned) ?? [];
				if (prose.length === 1) {
					let blocks = parse(room.project(stagedDocument)).children;
					let matches = room.digests(stagedDocument).flatMap((_, index) =>
						room.matchesAnchor(stagedDocument, prose[0]!, index) ? [index] : []
					);
					if (matches.length === 1 && blocks[matches[0]!]?.type === "paragraph") {
						let index = matches[0]!;
						room.placeQuestionnaires(stagedDocument, [{
							id: msg.id,
							at: { index, digest: room.digests(stagedDocument)[index]! },
							renew: true,
						}]);
					}
				}
				rebase(candidate, previousSource);
				let next: Record = {
					...candidate.records.get(msg.id)!,
					status: "reopened",
					history: [...record.history, {
						choices: [...selected],
						...(Object.keys(text).length ? { answers: text } : {}),
						owner,
						at,
					}],
				};
				delete next.answers;
				delete next.choices;
				delete next.resolver;
				delete next.at;
				delete next.owner;
				delete next.decidedAt;
				candidate.records.set(msg.id, next);
				let questions: Store.Questions = {
					open: new Map(plan.questions.open),
					closed: new Map(plan.questions.closed),
				};
				Store.reopen(questions, msg.id, record.definition, msg.id);
				await Service.publishStaged(plan, server, roomId, {
					...candidate,
					questions,
					pendingCardActions: pending(plan, record, {
						kind: "reopened",
						id: msg.id,
						actor: ws.data.handle,
					}),
				}, {
					update: Y.encodeStateAsUpdate(stagedDocument.doc, vector),
					source: room.project(stagedDocument),
				});
				result = { ok: true };
				// Keep publication in the room queue: a following discard must not
				// overtake this fresh draft's metadata and asked announcement.
				for (
					let notify of [
						() => respond({ ok: true }),
						() => announce(plan, server, roomId, msg.id),
						() =>
							broadcast(server, roomId, {
								kind: "question:asked",
								ts: 0,
								id: msg.id,
								definition: record.definition,
								widget: msg.id,
							}),
						() =>
							emit(plan, {
								kind: "reopened",
								id: msg.id,
								...(record.threadId ? { threadId: record.threadId } : {}),
								actor: ws.data.handle,
							}),
					]
				) {
					try {
						notify();
					} catch (err) {
						console.error("[questions] could not announce a reopened card:", err);
					}
				}
			} finally {
				stagedDocument.doc.destroy();
			}
		});
	} catch (err) {
		failure = err;
	}
	if (failure) {
		if (
			failure instanceof ConversationCapacityError
			|| failure instanceof Error && failure.message === "implementation is active"
		) {
			return fail(ws, msg.rid, failure.message);
		}
		console.error("[questions] could not reopen the card:", failure);
		return respond({ ok: false, reason: "resolving" });
	}
	if (!result) return respond({ ok: false, reason: "resolving" });
	if (!result.ok) respond(result);
}
