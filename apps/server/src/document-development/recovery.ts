import * as Y from "yjs";
import { assert, assertIntroducedUrls, limits, parse, ulid } from "@chopin/dialect";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import {
	applyHumanRecovery,
	encodeDeletes,
	hasPendingCausalHistory,
	subtract,
} from "./recovery-yjs";
import { MAX_RECOVERY_ADMISSION_BYTES, MAX_RETIRED, recoveryBytes } from "./recovery-state";
import { supported } from "./markdown";
import type { Plan } from "../plan/service";
import type { State } from "./state";
import type { Recovery } from "./recovery-state";

export class RecoveryValidationError extends Error {}

export { recoveryBytes } from "./recovery-state";
export { carryRecovery } from "./recovery-yjs";

/** An epoch is the existing explicit boundary for replaying old browser histories. */
export function currentRecovery(plan: Plan): Recovery | undefined {
	let recovery = plan.documentDevelopment?.recovery;
	if (!recovery || recovery.epoch === plan.document.epoch) return recovery;
	return {
		epoch: plan.document.epoch,
		document: Buffer.from(Y.encodeStateAsUpdate(plan.document.doc)).toString("base64"),
		deletes: encodeDeletes(Y.createDeleteSet()),
		retired: recovery.retired.filter(item => item.version?.status === "pending"),
	};
}

function recoveryBase(plan: Plan): Recovery {
	return currentRecovery(plan) ?? {
		epoch: plan.document.epoch,
		document: Buffer.from(Y.encodeStateAsUpdate(plan.document.doc)).toString("base64"),
		deletes: encodeDeletes(Y.createDeleteSet()),
		retired: [],
	};
}

/** Admission and publication share the same bounded retained-history capacity. */
export function canRetire(plan: Plan, count = 1): boolean {
	let recovery = recoveryBase(plan);
	return Number.isInteger(count) && count >= 0
		&& !hasPendingCausalHistory(plan.document.doc)
		&& recovery.retired.length + count <= MAX_RETIRED
		&& recoveryBytes(recovery) <= MAX_RECOVERY_ADMISSION_BYTES;
}

/** Reserve recovery before committing any automatic deletion of collaborative identities. */
export function prepareRecovery(plan: Plan, candidate: Plan, ids: string[]): boolean {
	if (!ids.length) return true;
	if (!canRetire(plan, ids.length)) return false;
	let state = candidate.documentDevelopment!;
	let recovery = recoveryBase(plan);
	let before = Y.snapshot(plan.document.doc);
	let after = Y.snapshot(candidate.document.doc);
	let ignored = Y.decodeSnapshot(Buffer.from(recovery.deletes, "base64")).ds;
	let retired = [...recovery.retired];
	for (let id of ids) {
		let passage = plan.documentDevelopment!.passages.find(item => item.id === id)!;
		retired.push({
			id: ulid(),
			passageId: id,
			anchor: { ...passage.anchor },
			seenDigest: passage.generatedDigest,
		});
	}
	state.recovery = {
		...recovery,
		deletes: encodeDeletes(Y.mergeDeleteSets([ignored, subtract(after.ds, before.ds)])),
		retired,
	};
	return true;
}

export function ordinaryRecovery(source: string): boolean {
	try {
		let tree = parse(source);
		assert(tree, { bytes: Buffer.byteLength(source) });
		assertIntroducedUrls([], tree.children);
		return tree.children.length === 1 && supported(tree.children[0]!);
	} catch {
		return false;
	}
}

/** The original raw bytes and any recovered prose share the caller's human-batch commit. */
export async function recoverHumanBatch(
	plan: Plan,
	updates: Uint8Array[],
): Promise<{ state: State; mutation?: room.Mutation } | undefined> {
	let recovery = currentRecovery(plan);
	if (recovery && hasPendingCausalHistory(plan.document.doc)) {
		throw new RecoveryValidationError("incomplete recovery history");
	}
	if (!recovery?.retired.some(item => item.anchor.epoch === recovery.epoch)) return undefined;
	let shadow: room.Document | undefined;
	try {
		let human = applyHumanRecovery(recovery, updates);
		shadow = await room.recoveryDocument(recovery.epoch, human.document);
		let retired = recovery.retired.map(item => ({ ...item }));
		let mutation: room.Mutation | undefined;
		let touched = human.touched;
		for (let item of retired) {
			if (item.anchor.epoch !== recovery.epoch) continue;
			let source = room.anchoredSource(shadow, item.anchor);
			if (!source) {
				if (item.seenDigest !== room.digest("")) {
					item.seenDigest = room.digest("");
					touched.add(item.passageId);
				}
				continue;
			}
			if (Buffer.byteLength(source) > limits.MAX_SOURCE_BYTES) {
				throw new RecoveryValidationError("recovered passage exceeds document limits");
			}
			let digest = room.digest(source);
			if (digest === item.seenDigest) continue;
			let first = !item.version;
			item.seenDigest = digest;
			item.version = { digest, source, status: "pending" };
			touched.add(item.passageId);
			// Continuing old-identity edits are explicit conflicts, never a rewrite of human prose.
			if (!first || !ordinaryRecovery(source)) continue;
			let result = edit.apply(plan, plan.revision, [{ op: "insert_root", source }]);
			if (!result.ok) continue;
			item.version.status = "added";
			if (result.mutation) {
				mutation = {
					...result.mutation,
					update: mutation
						? Y.mergeUpdates([mutation.update, result.mutation.update])
						: result.mutation.update,
				};
			}
		}
		let state: State = {
			...plan.documentDevelopment!,
			passages: plan.documentDevelopment!.passages.map(item =>
				touched.has(item.id) ? { ...item, status: "protected" } : item
			),
			recovery: {
				...recovery,
				document: Buffer.from(Y.encodeStateAsUpdate(shadow.doc)).toString("base64"),
				retired,
			},
		};
		return { state, ...(mutation ? { mutation } : {}) };
	} catch (error) {
		if (error instanceof RecoveryValidationError) throw error;
		throw new RecoveryValidationError("invalid retired passage update", { cause: error });
	} finally {
		shadow?.doc.destroy();
	}
}
