/** Validate and place a decided card's single paragraph in canonical document coordinates. */

import { parse } from "@chopin/dialect";

import * as room from "../plan/room";

import type * as edit from "../plan/edit";
import type { Plan } from "../plan/service";

export const MAX_PROSE = 600;

export type ProsePlan =
	| { ok: true; steps: edit.Operation[][]; index: number; mode: "insert" | "replace" }
	| { ok: false; message: string };

function inline(node: { type: string; children?: unknown[] }): boolean {
	if (node.type === "text" || node.type === "inlineCode" || node.type === "break") return true;
	if (!["strong", "emphasis", "delete", "link"].includes(node.type)) return false;
	return Array.isArray(node.children)
		&& node.children.every(child => inline(child as { type: string; children?: unknown[] }));
}

export function validateProse(
	raw: unknown,
): { ok: true; text: string } | { ok: false; message: string } {
	if (typeof raw !== "string") return { ok: false, message: "text must be a string" };
	let text = raw.trim();
	if (!text) return { ok: false, message: "text must not be empty" };
	if (text.length > MAX_PROSE) {
		return { ok: false, message: `text is at most ${MAX_PROSE} characters` };
	}
	try {
		let blocks = parse(`${text}\n`).children;
		if (blocks.length !== 1 || blocks[0]?.type !== "paragraph") {
			return { ok: false, message: "text must be exactly one ordinary paragraph" };
		}
		if (!blocks[0].children.every(child => inline(child))) {
			return { ok: false, message: "text must be exactly one ordinary paragraph" };
		}
	} catch {
		return { ok: false, message: "text must be exactly one ordinary paragraph" };
	}
	return { ok: true, text };
}

export function proseOperation(plan: Plan, id: string, text: string): ProsePlan {
	let record = plan.records.get(id);
	if (!record) return { ok: false, message: `no decision ${id}` };
	if (record.origin !== "conversation") {
		return { ok: false, message: "only conversation decisions are written up" };
	}
	if (record.status !== "answered" || !record.owner || !record.threadId) {
		return { ok: false, message: "this decision is not decided by a person" };
	}
	let card = room.questionnaireIndex(plan.document, id);
	if (card === undefined) {
		return { ok: false, message: "the decision card is not in the document" };
	}
	let source = `${text}\n`;
	let anchors = record.prose?.filter(anchor => !anchor.orphaned) ?? [];
	if (anchors.length > 1) return { ok: false, message: "decision prose is ambiguous" };
	if (anchors.length === 1) {
		let anchor = anchors[0]!;
		let matches = room.digests(plan.document).flatMap((_, index) =>
			room.matchesAnchor(plan.document, anchor, index) ? [index] : []
		);
		if (matches.length !== 1) {
			return { ok: false, message: "decision prose no longer has a unique live block" };
		}
		let index = matches[0]!;
		let blocks = parse(room.project(plan.document)).children;
		if (blocks[index]?.type !== "paragraph") {
			return { ok: false, message: "decision prose does not name a paragraph" };
		}
		return { ok: true, mode: "replace", index, steps: [[{ op: "replace", index, source }]] };
	}
	if (card > 0) {
		return {
			ok: true,
			mode: "insert",
			index: card,
			steps: [[{ op: "insert", index: card - 1, source }]],
		};
	}
	return {
		ok: true,
		mode: "insert",
		index: 0,
		steps: [[{ op: "insert", index: 0, source }], [{ op: "move", index: 0, to: 1 }]],
	};
}
