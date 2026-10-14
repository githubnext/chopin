import * as Y from "yjs";
import type { Recovery } from "./recovery-state";

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

/** Subtract sorted CRDT deletion intervals without changing any struct identities. */
export function subtract(left: DeleteSet, right: DeleteSet): DeleteSet {
	let result = Y.createDeleteSet();
	for (let [client, items] of left.clients) {
		let ranges: Array<{ clock: number; len: number }> = [];
		for (let item of items) {
			let start = item.clock;
			let end = start + item.len;
			for (let removed of right.clients.get(client) ?? []) {
				if (removed.clock >= end) break;
				if (removed.clock + removed.len <= start) continue;
				if (removed.clock > start) ranges.push({ clock: start, len: removed.clock - start });
				start = Math.max(start, removed.clock + removed.len);
				if (start >= end) break;
			}
			if (start < end) ranges.push({ clock: start, len: end - start });
		}
		if (ranges.length) result.clients.set(client, ranges);
	}
	return result;
}

export function encodeDeletes(deletes: DeleteSet): string {
	return Buffer.from(Y.encodeSnapshot(Y.createSnapshot(deletes, new Map()))).toString("base64");
}

/** Snapshot reconstruction cannot retain unresolved structs or future deletion dependencies. */
export function hasPendingCausalHistory(document: Y.Doc): boolean {
	let vector = Y.encodeStateVector(document);
	let pending = Y.decodeUpdate(Y.encodeStateAsUpdate(document, vector));
	if (pending.structs.length) return true;
	let clocks = Y.decodeStateVector(vector);
	for (let [client, intervals] of pending.ds.clients) {
		if (intervals.some(interval => interval.clock + interval.len > (clocks.get(client) ?? 0))) {
			return true;
		}
	}
	return false;
}

export function carryRecovery(
	recovery: Recovery,
	update: Uint8Array,
	humanPrepared = false,
): Recovery {
	let document = new Y.Doc({ gc: false });
	let carried: Y.Doc | undefined;
	try {
		Y.applyUpdate(document, Buffer.from(recovery.document, "base64"));
		let before = Y.snapshot(document);
		Y.applyUpdate(document, update);
		if (hasPendingCausalHistory(document)) throw new Error("incomplete recovery history");
		let ignored = Y.decodeSnapshot(Buffer.from(recovery.deletes, "base64")).ds;
		// Applying a late edit to the real deleted parent also deletes its new structs.
		// They are live human text in this already-updated shadow, so retain that difference.
		if (humanPrepared) {
			ignored = Y.mergeDeleteSets([ignored, subtract(Y.decodeUpdate(update).ds, before.ds)]);
		}
		let accepted = subtract(Y.decodeUpdate(update).ds, ignored);
		let after = Y.snapshot(document);
		carried = Y.createDocFromSnapshot(
			document,
			Y.createSnapshot(Y.mergeDeleteSets([before.ds, accepted]), after.sv),
			new Y.Doc(),
		);
		return {
			...recovery,
			deletes: encodeDeletes(ignored),
			document: Buffer.from(Y.encodeStateAsUpdate(carried)).toString("base64"),
		};
	} finally {
		carried?.destroy();
		document.destroy();
	}
}

/** A state-vector update may repeat deletes from a generated replacement it already observed. */
export function applyHumanRecovery(
	recovery: Recovery,
	updates: Uint8Array[],
): { document: Uint8Array; touched: Set<string> } {
	let bytes = Buffer.from(recovery.document, "base64") as Uint8Array;
	let ignored = Y.decodeSnapshot(Buffer.from(recovery.deletes, "base64")).ds;
	let touched = new Set<string>();
	let update = Y.mergeUpdates(updates);
	let document = new Y.Doc({ gc: false });
	let carried: Y.Doc | undefined;
	try {
		Y.applyUpdate(document, bytes);
		let before = Y.snapshot(document);
		let deleted = Y.decodeUpdate(update).ds;
		let roots: Array<{ type: Y.AbstractType<unknown>; id: Y.ID }> = [];
		for (let passage of recovery.retired) {
			if (passage.anchor.epoch !== recovery.epoch) continue;
			let position = Y.decodeRelativePosition(Buffer.from(passage.anchor.position, "base64"));
			let absolute = Y.createAbsolutePositionFromRelativePosition(position, document);
			if (!position.type || !absolute || !Y.isDeleted(deleted, position.type)) continue;
			roots.push({ type: absolute.type, id: position.type });
			touched.add(passage.passageId);
		}
		Y.applyUpdate(document, update);
		if (hasPendingCausalHistory(document)) throw new Error("incomplete recovery history");
		let repeated = Y.createDeleteSet();
		for (let [client, intervals] of ignored.clients) {
			let ranges: Array<{ clock: number; len: number }> = [];
			for (let interval of intervals) {
				let clock = interval.clock;
				let end = Math.min(clock + interval.len, Y.getState(document.store, client));
				while (clock < end) {
					let item = Y.getItem(document.store, Y.createID(client, clock));
					let length = Math.min(item.id.clock + item.length, end) - clock;
					if (
						item instanceof Y.Item
						&& roots.some(root =>
							root.id.client === client && root.id.clock === item.id.clock
							|| Y.isParentOf(root.type, item)
						)
					) ranges.push({ clock, len: length });
					clock += length;
				}
			}
			if (ranges.length) repeated.clients.set(client, ranges);
		}
		carried = Y.createDocFromSnapshot(
			document,
			Y.createSnapshot(
				Y.mergeDeleteSets([before.ds, subtract(deleted, repeated)]),
				Y.snapshot(document).sv,
			),
			new Y.Doc(),
		);
		bytes = Y.encodeStateAsUpdate(carried);
	} finally {
		carried?.destroy();
		document.destroy();
	}
	return { document: bytes, touched };
}
