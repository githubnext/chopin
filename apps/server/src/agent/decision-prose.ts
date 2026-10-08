import * as Y from "yjs";
import * as Comments from "../comments/service";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { decisionGeneration, proseJobTrigger } from "../questions/card-actions";
import * as Questions from "../questions/service";
import { proseOperation } from "../questions/write-prose";
import { input } from "./decision-prose-fields";
import type { Context } from "./card-tool-context";
import type { ConversationPlan } from "@chopin/protocol";

export async function write(
	context: Context,
	job: ConversationPlan.Job,
	turn: Context["plan"]["chat"]["turn"],
	raw: unknown,
): Promise<{ output: { title: string; mode: "insert" | "replace" }; revision: number }> {
	return context.exclusive(async () => {
		let { plan } = context;
		let args = input(raw);
		let active = () => {
			let record = plan.records.get(args.id);
			return plan.chat.job === job && plan.chat.turn === turn
				&& job.status === "running" && job.kind === "prose" && job.target === args.id
				&& record?.origin === "conversation" && record.status === "answered"
				&& !!record.owner && !!record.threadId
				&& job.trigger === proseJobTrigger(args.id, decisionGeneration(record));
		};
		if (job.target !== args.id) throw new Error("This job writes up a different decision.");
		if (!active()) throw new Error("background Planner job generation is no longer current");
		if (args.revision !== plan.revision) throw new Error("stale; read_plan again");
		if (Service.implementationActive(plan)) throw new Error("implementation is active");

		let source = room.project(plan.document);
		let vector = Y.encodeStateVector(plan.document.doc);
		let candidate: Service.Plan = {
			...plan,
			records: new Map(plan.records),
			threads: new Map(plan.threads),
			outlines: new Map(plan.outlines),
		};
		// Resolve old relationships before server-authored source edits can move their blocks.
		Questions.rebase(candidate);
		Comments.rebase(candidate);
		let stagedDocument = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			source,
			[],
		);
		stagedDocument.seq = plan.document.seq;
		candidate.document = stagedDocument;
		try {
			let planned = proseOperation(candidate, args.id, args.text);
			if (!planned.ok) throw new Error(planned.message);
			for (let operations of planned.steps) {
				let outcome = edit.apply(candidate, args.revision, operations);
				if (!outcome.ok) {
					throw new Error(outcome.reason === "stale" ? "stale; read_plan again" : outcome.message);
				}
				if (!outcome.mutation) throw new Error("decision prose did not change the document");
			}
			Questions.rebase(candidate, source);
			Comments.rebase(candidate);
			let hash = room.digests(candidate.document)[planned.index];
			if (!hash) throw new Error("decision prose did not land in the document");
			Questions.setProse(candidate, args.id, [
				room.anchorAt(candidate.document, planned.index, hash),
			]);
			if (!active() || args.revision !== plan.revision) {
				throw new Error("background Planner job changed before its tool completed");
			}
			let mutation: room.Mutation = {
				update: Y.encodeStateAsUpdate(candidate.document.doc, vector),
				source: room.project(candidate.document),
			};
			let block = edit.outline(candidate)[planned.index];
			if (!block || block.type !== "paragraph") {
				throw new Error("decision prose did not land as a paragraph");
			}
			await Service.publishStaged(plan, context.server, context.room, candidate, mutation, {
				agent: true,
			});
			try {
				context.changes([{
					kind: "added",
					index: planned.index,
					type: block.type,
					preview: block.preview,
				}]);
			} catch (error) {
				console.error("[agent/write_decision_prose] could not announce committed change:", error);
			}
			try {
				context.anchors();
			} catch (error) {
				console.error("[agent/write_decision_prose] could not announce committed anchors:", error);
			}
			let title = plan.records.get(args.id)?.definition.questions[0]?.question ?? "a decision";
			return { output: { title, mode: planned.mode }, revision: plan.revision };
		} finally {
			stagedDocument.doc.destroy();
		}
	});
}
