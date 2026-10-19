import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import { reply } from "../wire";
import type { Socket, SocketData } from "../wire";

import { announce } from "./card-notifications";
import { personWhy } from "./why";

/**
 * Write, replace or clear a settled decision's why for a person, persisting the record before it
 * is announced or acknowledged. A person's words always win over Chopin's draft: once `whyBy`
 * names them, only another person's edit changes it.
 */
export async function setWhy(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Why.Ask>,
): Promise<void> {
	let answer = (body: { ok: true; why?: string } | { ok: false; message: string }) =>
		reply(ws, msg.rid, { kind: "question:why", ts: 0, id: msg.id, ...body });
	let checked = personWhy(msg.text);
	if (!checked.ok) return answer(checked);
	let { text } = checked;
	try {
		let refusal = await Service.exclusive(plan, async () => {
			let record = plan.records.get(msg.id);
			if (!record) return "Decision not found";
			if (record.status !== "answered") return "Only a settled decision has a why";
			if (text === (record.why ?? "") && (!text || record.whyBy)) return undefined;
			let { why: _why, whyBy: _whyBy, ...rest } = record;
			let previous = plan.records;
			// Clearing a why a person or Chopin wrote keeps `whyBy` with no `why`, so a draft that
			// lands later for the same settle never refills what they emptied.
			plan.records = new Map(previous).set(
				msg.id,
				text ? { ...rest, why: text, whyBy: ws.data.handle } : { ...rest, whyBy: ws.data.handle },
			);
			try {
				await Service.persistExclusive(plan);
			} catch (error) {
				plan.records = previous;
				throw error;
			}
			announce(plan, server, roomId, msg.id);
			return undefined;
		});
		answer(
			refusal ? { ok: false, message: refusal } : { ok: true, ...(text ? { why: text } : {}) },
		);
	} catch (error) {
		answer({ ok: false, message: error instanceof Error ? error.message : "Could not save it" });
	}
}
