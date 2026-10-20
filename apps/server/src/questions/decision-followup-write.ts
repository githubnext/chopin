import * as Y from "yjs";
import { parse } from "@chopin/dialect";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";
import * as Comments from "../comments/service";
import * as Edit from "../plan/edit";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Relationships from "./service-relationships";
import { decisionGeneration } from "./card-actions";
import { followupIntent, scopeSnapshot } from "./decision-followup";
import type { DocumentRoom } from "../agent/tools";
import type { ConversationPlan } from "@chopin/protocol";

export type ScopeWrite = { id: string; revision: number; answersHash: string; source: string };

/** The receipt and all peer anchors travel in the same fenced commit as the replacement. */
export async function writeScope(
	context: DocumentRoom,
	job: ConversationPlan.Job,
	turn: DocumentRoom["plan"]["chat"]["turn"],
	args: ScopeWrite,
	signal?: AbortSignal,
) {
	let { plan } = context;
	let active = () => {
		let record = plan.records.get(args.id);
		if (signal?.aborted || context.turnSignal?.()?.aborted) {
			throw new Error("decision follow-up cancelled");
		}
		if (
			plan.chat.job !== job || plan.chat.turn !== turn || job.status !== "running"
			|| job.kind !== "decision-followup" || job.target !== args.id
			|| !record || followupIntent(record)?.trigger !== job.trigger
		) {
			throw new Error("decision follow-up generation is no longer current");
		}
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		return record;
	};
	let preflight = await context.exclusive(async () => {
		let record = active();
		if (record.followUp!.appliedGeneration === decisionGeneration(record)) {
			return { replay: true as const };
		}
		if (args.revision !== plan.revision) throw new Error("stale; read_decision_scope again");
		let snapshot = scopeSnapshot(plan, args.id);
		if (snapshot.answersHash !== args.answersHash) {
			throw new Error("saved answers changed; read_decision_scope again");
		}
		if (typeof args.source !== "string" || args.source.length > 50_000) {
			throw new Error("scope source exceeds 50000 characters");
		}
		let blocks = parse(args.source).children;
		if (
			!blocks.length || blocks.length > 8 || blocks[0]!.type !== "paragraph"
			|| blocks.slice(1).some(block =>
				block.type !== "table"
				&& !(block.type === "code" && block.lang === SEECODE_LANGUAGE)
			)
		) {
			throw new Error("write one paragraph followed only by native diagrams or tables");
		}
		let operations: Edit.Operation[] = [
			{ op: "replace", index: snapshot.indices[0]!, source: args.source },
			...snapshot.indices.slice(1).map(index => ({ op: "delete" as const, index })),
		];
		let prepared = Edit.prepare(plan, args.revision, operations);
		if (!prepared.ok) {
			throw new Error(prepared.reason === "invalid" ? prepared.message : "stale scope");
		}
		return {
			replay: false as const,
			snapshot,
			before: Edit.source(plan),
			source: prepared.source,
			count: blocks.length,
		};
	});
	if (preflight.replay) return { output: { id: args.id, replayed: true }, revision: plan.revision };
	if (!context.visualAdmission) throw new Error("visual assessment is unavailable");
	let issues = await context.visualAdmission({
		before: preflight.before,
		sources: [preflight.source],
		signal,
	});
	if (issues.length) throw new Error(`visuals-required: ${JSON.stringify(issues)}`);
	return context.exclusive(async () => {
		let record = active();
		if (record.followUp!.appliedGeneration === decisionGeneration(record)) {
			return { output: { id: args.id, replayed: true }, revision: plan.revision };
		}
		let snapshot = scopeSnapshot(plan, args.id);
		// An unrelated edit can advance the document while assessment runs. Only reuse the
		// assessment when the complete passage and saved answers are still the ones assessed.
		if (
			snapshot.scope !== preflight.snapshot.scope
			|| snapshot.source !== preflight.snapshot.source
			|| snapshot.context !== preflight.snapshot.context
			|| snapshot.answersHash !== args.answersHash
		) {
			throw new Error("stale; read_decision_scope again");
		}
		let revision = plan.revision;
		let operations: Edit.Operation[] = [
			{ op: "replace", index: snapshot.indices[0]!, source: args.source },
			...snapshot.indices.slice(1).map(index => ({ op: "delete" as const, index })),
		];
		let source = Room.project(plan.document);
		let candidate: Service.Plan = {
			...plan,
			records: new Map(plan.records),
			threads: new Map(plan.threads),
			outlines: new Map(plan.outlines),
		};
		Relationships.rebase(candidate);
		Comments.rebase(candidate);
		let staged = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			source,
			[],
		);
		staged.seq = plan.document.seq;
		candidate.document = staged;
		try {
			let outcome = Edit.apply(candidate, revision, operations);
			if (!outcome.ok) throw new Error("stale decision scope");
			Relationships.rebase(candidate, source);
			Comments.rebase(candidate);
			let indices = Array.from(
				{ length: preflight.count },
				(_, index) => snapshot.indices[0]! + index,
			);
			let digests = Room.digests(staged);
			let anchors = indices.map(index => Room.anchorAt(staged, index, digests[index]!));
			for (let peer of snapshot.decisions) {
				let value = candidate.records.get(peer.id)!;
				let question = value.definition.questions[0]!;
				candidate.records.set(peer.id, {
					...value,
					followUp: {
						...value.followUp!,
						target: anchors,
						...(peer.status === "answered" ? { appliedGeneration: peer.generation } : {}),
					},
					...(peer.status === "answered" ? { prose: anchors } : {}),
				});
				Relationships.relate(
					candidate,
					peer.id,
					question.id,
					indices.map(index => ({ index, digest: digests[index]! })),
				);
			}
			active();
			await Service.publishStaged(plan, context.server, context.id, candidate, outcome.mutation, {
				agent: true,
			});
			try {
				context.anchors();
				context.changes(outcome.changes);
			} catch (error) {
				console.error("[decision-followup] could not announce committed scope:", error);
			}
			return { output: { id: args.id, replayed: false }, revision: plan.revision };
		} finally {
			staged.doc.destroy();
		}
	});
}
