import * as Store from "./store";

import { fail, relay, reply, tell } from "../wire";

import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket } from "../wire";
import type { Questions } from "./store";

import { announce, meta } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export function greet(plan: Plan, ws: Socket): void {
	let cards = [...plan.records.values()].map(record => ({
		id: record.id,
		meta: meta(plan, record),
	}));
	if (cards.length > 0) tell(ws, { kind: "question:metas", ts: 0, cards });
	let open = Store.outstanding(plan.questions);
	if (open.length === 0) return;
	tell(ws, { kind: "question:sync", ts: 0, open });
}

export function open(plan: Plan, ws: Socket, msg: Request<Wire.Open.Ask>): void {
	reply(ws, msg.rid, { kind: "question:open", ts: 0, ...Store.snapshot(plan.questions, msg.id) });
}

export async function edit(plan: Plan, ws: Socket, msg: Request<Wire.Edit.Ask>): Promise<void> {
	let outcome: Store.Edited | undefined;
	let failure: unknown;
	await Service.exclusive(plan, async () => {
		let originalQuestions = plan.questions;
		if (!Store.reserveEdit(originalQuestions, msg.id)) {
			outcome = Store.edit(originalQuestions, msg.id, msg.patch);
			return;
		}
		try {
			let entry = Store.get(originalQuestions, msg.id)!;
			let stagedQuestions: Store.Questions = {
				open: new Map(originalQuestions.open),
				closed: new Map(originalQuestions.closed),
			};
			stagedQuestions.open.set(msg.id, {
				...entry,
				claim: undefined,
				editors: new Set(entry.editors),
			});
			outcome = Store.edit(stagedQuestions, msg.id, msg.patch, ws.data.handle);
			if (outcome.open && outcome.accepted && outcome.applied) {
				let record = plan.records.get(msg.id);
				if (!record) throw new Error("card record is missing");
				let records = new Map(plan.records);
				records.set(msg.id, {
					...record,
					editors: [...new Set([...record.editors, ...stagedQuestions.open.get(msg.id)!.editors])],
				});
				await Service.publishStaged(plan, plan.server, plan.id, {
					...plan,
					questions: stagedQuestions,
					records,
				});
			}
		} catch (err) {
			failure = err;
		} finally {
			Store.releaseEdit(originalQuestions, msg.id);
		}
	});
	if (failure || !outcome) {
		return fail(ws, msg.rid, "could not save questionnaire draft");
	}
	reply(ws, msg.rid, { kind: "question:edit", ts: 0, id: msg.id, ...outcome });
	// A no-op patch is acknowledged but not relayed: peers have nothing to do
	// with it and it did not move the revision.
	if (!outcome.open || !outcome.accepted || !outcome.applied) return;
	relay(ws, {
		kind: "question:edit",
		ts: 0,
		id: msg.id,
		open: true,
		accepted: true,
		applied: true,
		revision: outcome.revision,
		patch: msg.patch,
		editor: ws.data.handle,
	});
	announce(plan, plan.server, plan.id, msg.id);
}

export function focus(plan: Plan, ws: Socket, msg: Wire.Presence.Input): void {
	let person = {
		client: ws.data.client,
		handle: ws.data.handle,
		...(msg.question ? { question: msg.question } : {}),
		...(msg.field ? { field: msg.field } : {}),
	};
	if (!Store.focus(plan.questions, msg.id, person)) return;
	relay(ws, { kind: "question:presence", ts: 0, ...person, id: msg.id });
}

export function away(plan: Plan, ws: Socket): void {
	for (let id of Store.away(plan.questions, ws.data.client)) {
		relay(ws, {
			kind: "question:presence",
			ts: 0,
			id,
			client: ws.data.client,
			handle: ws.data.handle,
		});
	}
}

export function shutdown(questions: Questions): void {
	Store.shutdown(questions);
}
