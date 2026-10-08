import { ulid } from "@chopin/dialect";
import * as Y from "yjs";
import * as room from "../plan/room";
import { Visual } from "@chopin/question";
import type { VisualDecision } from "@chopin/protocol";
import * as Service from "../plan/service";
import { fail, reply } from "../wire";
import type { Socket } from "../wire";
import * as State from "./state";
import { changed, fields, queued, writable } from "./common";
import type { Input, Lifecycle } from "./common";

export async function create(
	plan: Service.Plan,
	ws: Socket,
	msg: Input<"visual-decision:create">,
	builtin: VisualDecision.Definition,
	lifecycle?: Lifecycle,
): Promise<void> {
	try {
		fields(msg, ["key"]);
		let key = State.createKey(msg.key);
		let definition = Visual.definition(builtin);
		let state: VisualDecision.State | undefined;
		let added = false;
		await queued(plan, async () => {
			writable(plan, ws);
			let existing = [...plan.visualDecisions.values()].find(record => record.createKey === key);
			if (existing) {
				state = State.snapshot(existing);
				return;
			}
			if (plan.visualDecisions.size >= State.MAX_DECISIONS) {
				throw new Error("This document already has 20 visual decisions");
			}
			let id = ulid();
			let stored: State.Stored = {
				id,
				questionId: ulid(),
				createKey: key,
				definition,
				revision: 0,
				values: { ...definition.baseline },
				edits: {},
			};
			let document = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			document.seq = plan.document.seq;
			try {
				let mutation = room.insertQuestionnaires(document, [{
					value: {
						id,
						visual: "decision-card-v1",
						status: "open",
						questions: [{
							id: stored.questionId,
							header: "Decision card",
							prompt: "How should selected options look?",
							multiple: false,
							options: [{
								id: ulid(),
								label: "Selected option",
								description: "Tune padding and colour together.",
							}],
						}],
					},
				}]);
				room.validate(room.project(document));
				if (
					!room.fitsOrShrinks(
						room.project(plan.document),
						room.project(document),
						plan.questions.open.size,
					)
				) {
					throw new Error("The document has no room for another visual decision");
				}
				await Service.publishStaged(
					plan,
					plan.server,
					plan.id,
					{
						...plan,
						document,
						visualDecisions: new Map(plan.visualDecisions).set(id, stored),
					},
					mutation,
					{ retryRejectedCommit: true },
				);
				state = State.snapshot(stored);
				added = true;
			} finally {
				document.doc.destroy();
			}
		}, lifecycle);
		reply(ws, msg.rid, { kind: msg.kind, ts: 0, ok: true, state: state! });
		if (added) changed(plan, state!);
	} catch (error) {
		fail(ws, msg.rid, error instanceof Error ? error.message : "Could not create visual decision");
	}
}
