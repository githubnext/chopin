/** The paragraph a decided card became, carried without a pending-review state. */

import { parse, serialize } from "@chopin/dialect";
import * as room from "../plan/room";

import type { Plan } from "@chopin/protocol";

/**
 * Prefer the live Yjs block. Durable callers supply the prior source, so a
 * lost position may recover by digest only when that digest was unique before
 * the edit as well as after it. Otherwise deleting one of two identical
 * paragraphs could steal the survivor. Without prior source, retain the
 * original two-argument rebasing behavior for direct callers. A unique block
 * that disappears has one source-changing edit to reappear; an intervening
 * edit from anyone consumes that window and leaves the prose orphaned.
 */
export function carry(
	document: room.Document,
	anchors: Plan.Anchor[],
	previousSource?: string,
): Plan.Anchor[] {
	if (anchors.length === 0) return anchors;
	let currentSource = previousSource === undefined ? undefined : room.project(document);
	let previous = new Map<string, number>();
	if (previousSource !== undefined) {
		for (let node of parse(previousSource).children) {
			let hash = room.digest(serialize({ type: "root", children: [node] }));
			previous.set(hash, (previous.get(hash) ?? 0) + 1);
		}
	}
	return anchors.map(anchor => {
		if (anchor.orphaned) {
			if (!anchor.recoverOnNextEdit) return room.rebase(document, [anchor])[0]!;
			let { recoverOnNextEdit: _recover, orphaned: _orphaned, ...candidate } = anchor;
			if (anchor.epoch !== document.epoch) {
				return { ...candidate, epoch: document.epoch, orphaned: true };
			}
			if (currentSource === undefined || currentSource === previousSource) return anchor;
			return room.rebase(document, [candidate])[0]!;
		}
		// Rebuilds change the epoch but can retain this exact Yjs history.
		let currentEpoch = { ...anchor, epoch: document.epoch };
		let live = room.resolveAnchor(document, currentEpoch);
		if (!live && previousSource !== undefined && previous.get(anchor.digest) !== 1) {
			return { ...anchor, epoch: document.epoch, orphaned: true };
		}
		let rebased = room.rebase(document, [live ? currentEpoch : anchor])[0]!;
		return rebased.orphaned && previousSource !== undefined
				&& previous.get(anchor.digest) === 1 && currentSource !== previousSource
				&& anchor.epoch === document.epoch
				&& !room.digests(document).includes(anchor.digest)
			? { ...rebased, recoverOnNextEdit: true }
			: rebased;
	});
}

/** No prose is different from prose whose every block was lost. */
export function orphaned(anchors: Plan.Anchor[] | undefined): boolean {
	return !!anchors?.length && anchors.every(anchor => anchor.orphaned);
}
