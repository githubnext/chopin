import * as Y from "yjs";
import * as room from "../plan/room";
import { Visual } from "@chopin/question";
import type { VisualDecision } from "@chopin/protocol";
import * as Service from "../plan/service";
import { fail, reply } from "../wire";
import type { Socket } from "../wire";
import * as State from "./state";
import { changed, claimed, fields, queued, writable } from "./common";
import type { Input, Lifecycle } from "./common";

export async function save(
	plan: Service.Plan,
	ws: Socket,
	msg: Input<"visual-decision:save">,
	lifecycle?: Lifecycle,
): Promise<void> {
	let id: string | undefined;
	let captured: State.Stored | undefined;
	let ownsClaim = false;
	try {
		fields(msg, ["id", "revision"]);
		id = Visual.id(msg.id);
		let revision = Visual.revision(msg.revision);
		writable(plan, ws);
		captured = plan.visualDecisions.get(id);
		if (!captured) throw new Error("Visual decision is unavailable");
		if (captured.saved || claimed(plan).has(id) || revision !== captured.revision) {
			reply(ws, msg.rid, {
				kind: msg.kind,
				ts: 0,
				ok: false,
				reason: captured.saved ? "saved" : claimed(plan).has(id) ? "saving" : "stale",
				state: State.snapshot(captured),
			});
			return;
		}
		claimed(plan).set(id, captured);
		ownsClaim = true;
		let result: VisualDecision.State | undefined;
		await queued(plan, async () => {
			writable(plan, ws);
			if (plan.visualDecisions.get(id!) !== captured) {
				throw new Error("Visual decision changed while saving");
			}
			let at = new Date().toISOString();
			let saved: VisualDecision.Saved = {
				revision,
				values: { ...captured!.values },
				by: ws.data.handle,
				at,
			};
			let next: State.Stored = { ...captured!, saved };
			let document = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			document.seq = plan.document.seq;
			try {
				let mutation = room.projectAnswer(document, id!, {
					[captured!.questionId]: Visual.summary(saved.values),
				}, { by: saved.by, at });
				room.validate(room.project(document));
				if (
					!room.fitsOrShrinks(
						room.project(plan.document),
						room.project(document),
						plan.questions.open.size,
					)
				) throw new Error("The saved values would exceed the document limit");
				await Service.publishStaged(plan, plan.server, plan.id, {
					...plan,
					document,
					visualDecisions: new Map(plan.visualDecisions).set(id!, next),
				}, mutation);
				result = State.snapshot(next);
			} finally {
				document.doc.destroy();
			}
		}, lifecycle);
		reply(ws, msg.rid, { kind: msg.kind, ts: 0, ok: true, state: result! });
		changed(plan, result!);
	} catch (error) {
		fail(ws, msg.rid, error instanceof Error ? error.message : "Could not save visual decision");
	} finally {
		if (ownsClaim && id && captured && claimed(plan).get(id) === captured) claimed(plan).delete(id);
	}
}
