import * as Y from "yjs";
import { parse, serialize, ulid } from "@chopin/dialect";
import * as Comments from "../comments/service";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { canonical } from "./markdown";
import { prepareRecovery } from "./recovery";
import { capture, indexOf, initial, MAX_PASSAGES, MAX_SOURCE } from "./state";

import type { Passage } from "./state";

export type Reconciliation = {
	jobId: string;
	messageId: string;
	/** Captured evidence and editable passages, supplied by the durable job input. */
	sourceIds: string[];
	passages: Array<{ id: string; digest: string }>;
	changes: Array<{ id: string | null; markdown: string; sourceIds: string[] }>;
	removals: string[];
};

export type ReconcileResult = {
	status: "applied" | "unchanged" | "repeated" | "stale" | "deferred" | "blocked" | "capacity";
	revision: number;
};

function validate(
	request: Reconciliation,
): Array<{ source: string; id: string | null; sourceIds: string[] }> {
	if (
		!request.jobId || !request.messageId || request.jobId.length > 200
		|| request.messageId.length > 200 || request.changes.length + request.removals.length > 48
		|| request.sourceIds.length > 24 || new Set(request.sourceIds).size !== request.sourceIds.length
		|| request.passages.length > MAX_PASSAGES
		|| new Set(request.passages.map(item => item.id)).size !== request.passages.length
	) throw new Error("invalid document development reconciliation");
	let known = new Set(request.passages.map(item => item.id));
	let touched = new Set<string>();
	let target = (id: string) => {
		if (!known.has(id) || touched.has(id)) {
			throw new Error("document development patch names an unknown or repeated passage");
		}
		touched.add(id);
	};
	let changes = request.changes.map(change => {
		if (change.id !== null) target(change.id);
		if (
			change.sourceIds.length < 1 || change.sourceIds.length > 24
			|| new Set(change.sourceIds).size !== change.sourceIds.length
			|| change.sourceIds.some(id => !request.sourceIds.includes(id))
		) throw new Error("document development patch cites uncaptured evidence");
		return { ...change, source: canonical(change.markdown) };
	});
	for (let id of request.removals) target(id);
	if (changes.reduce((size, change) => size + change.source.length, 0) > MAX_SOURCE) {
		throw new Error("document development patch exceeds its source budget");
	}
	return changes;
}

/** Apply a completed immutable artifact, with its receipt in the same fenced document commit. */
export async function reconcile(
	plan: Service.Plan,
	request: Reconciliation,
	fresh: () => boolean,
): Promise<ReconcileResult> {
	let changes = validate(request);
	await Service.drain(plan);
	return Service.exclusive(plan, async () => {
		let result = (status: ReconcileResult["status"]): ReconcileResult => ({
			status,
			revision: plan.revision,
		});
		if (Service.implementationActive(plan) || plan.documentDevelopment?.paused) {
			return result("blocked");
		}
		if (plan.queue.length > 0) return result("deferred");
		let state = capture(plan) ?? initial();
		if (state.lastJobId === request.jobId || state.lastMessageId === request.messageId) {
			if (state.pending?.input.messageId === request.messageId) {
				let { pending: _pending, ...settled } = state;
				await Service.publishStaged(plan, plan.server, plan.id, {
					...plan,
					documentDevelopment: settled,
				});
			}
			return result("repeated");
		}
		if (!fresh()) return result("stale");
		let indices = new Map<string, number>();
		for (
			let id of [...changes.flatMap(item => item.id === null ? [] : [item.id]), ...request.removals]
		) {
			let passage = state.passages.find(item => item.id === id);
			let baseline = request.passages.find(item => item.id === id);
			if (
				!passage || passage.status !== "generated" || baseline?.digest !== passage.generatedDigest
			) {
				return result("stale");
			}
			let index = indexOf(plan.document, passage);
			if (index === undefined) return result("stale");
			indices.set(id, index);
		}
		if (state.passages.length + changes.filter(item => item.id === null).length > MAX_PASSAGES) {
			return result("capacity");
		}
		let source = room.project(plan.document);
		let vector = Y.encodeStateVector(plan.document.doc);
		let candidate: Service.Plan = {
			...plan,
			records: new Map(plan.records),
			threads: new Map(plan.threads),
			outlines: new Map(plan.outlines),
			documentDevelopment: state,
		};
		Questions.rebase(candidate);
		Comments.rebase(candidate);
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			source,
			[],
		);
		document.seq = plan.document.seq;
		candidate.document = document;
		try {
			let operations: edit.Operation[] = [];
			let replacements = new Map<string, typeof changes[number]>();
			let additions = changes.filter(item => item.id === null);
			for (let change of changes) {
				if (change.id === null) {
					operations.push({ op: "insert_root", source: change.source });
					continue;
				}
				let passage = state.passages.find(item => item.id === change.id)!;
				if (room.digest(change.source) === passage.generatedDigest) continue;
				replacements.set(change.id, change);
				operations.push({ op: "replace", index: indices.get(change.id)!, source: change.source });
			}
			for (let id of request.removals) operations.push({ op: "delete", index: indices.get(id)! });
			let outcome = operations.length
				? edit.apply(candidate, plan.revision, operations)
				: undefined;
			if (outcome && !outcome.ok) {
				throw new Error(
					outcome.reason === "invalid" ? outcome.message : "document development became stale",
				);
			}
			Questions.rebase(candidate, source);
			Comments.rebase(candidate);
			let hashes = room.digests(document);
			let removed = request.removals.map(id => indices.get(id)!);
			let passages = state.passages.map((passage): Passage => {
				if (request.removals.includes(passage.id)) return { ...passage, status: "orphaned" };
				let change = replacements.get(passage.id);
				if (!change) return passage;
				let before = indices.get(passage.id)!;
				let index = before - removed.filter(item => item < before).length;
				return {
					...passage,
					anchor: room.anchorAt(document, index, hashes[index]!),
					generatedDigest: hashes[index]!,
					sourceIds: [...change.sourceIds],
				};
			});
			for (let [offset, addition] of additions.entries()) {
				let index = hashes.length - additions.length + offset;
				passages.push({
					id: ulid(),
					anchor: room.anchorAt(document, index, hashes[index]!),
					generatedDigest: hashes[index]!,
					sourceIds: [...addition.sourceIds],
					status: "generated",
				});
			}
			candidate.documentDevelopment = {
				...state,
				lastMessageId: request.messageId,
				lastJobId: request.jobId,
				lastOutcome: outcome?.mutation ? "updated" : "unchanged",
				passages,
			};
			if (candidate.documentDevelopment.pending?.input.messageId === request.messageId) {
				delete candidate.documentDevelopment.pending;
			}
			if (!prepareRecovery(plan, candidate, [...replacements.keys(), ...request.removals])) {
				return result("capacity");
			}
			let authored = capture(candidate)!;
			if (generatedSize(candidate, authored.passages) > MAX_SOURCE) return result("capacity");
			if (!fresh()) return result("stale");
			if (plan.queue.length > 0) return result("deferred");
			let mutation = outcome?.mutation && {
				update: Y.encodeStateAsUpdate(document.doc, vector),
				source: room.project(document),
			};
			await Service.publishStaged(plan, plan.server, plan.id, candidate, mutation, { agent: true });
			if (outcome) Service.changes(plan, plan.server, plan.id, outcome.changes);
			Service.anchors(plan, plan.server, plan.id);
			return result(mutation ? "applied" : "unchanged");
		} finally {
			document.doc.destroy();
		}
	});
}

function generatedSize(plan: Service.Plan, passages: Passage[]): number {
	let source = room.project(plan.document);
	let blocks = parse(source).children.map(node => serialize({ type: "root", children: [node] }));
	return passages.reduce((size, passage) => {
		let index = passage.status === "generated" ? indexOf(plan.document, passage) : undefined;
		return size + (index === undefined ? 0 : blocks[index]?.length ?? 0);
	}, 0);
}
