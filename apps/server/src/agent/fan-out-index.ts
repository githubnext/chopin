/**
 * The table of the documents a document created, kept in that document under its own heading: the
 * heading and the one block after it are Chopin's, and every other block is left alone. Written as
 * an ordinary validated, persisted-before-published edit, and not at all when nothing changed.
 */
import * as edit from "../plan/edit";
import { admitBlockEdit, applyBlockEdit } from "./document-ops";
import { implementationActive } from "../plan/service";

import type { CreatedDocumentState, IndexOutcome } from "./fan-out";
import type { DocumentRoom } from "./tools";

export const INDEX_HEADING = "Documents created from this one";
const EMPTY = "No document has been created from this one yet.";
/** A batch that finds the document moved on between its read and its write is tried this often. */
const ATTEMPTS = 3;

function cell(text: string): string {
	return text.replace(/\s+/g, " ").replace(/([\\|[\]])/g, "\\$1").trim();
}

/** The section's body: one table row per document, or a sentence when there are none. */
export function indexBody(documents: CreatedDocumentState[]): string {
	if (documents.length === 0) return EMPTY;
	return [
		"| Document | Planner | Open decisions | Build |",
		"| --- | --- | --- | --- |",
		...documents.map(document =>
			`| [${cell(document.title)}](${document.url}) | ${document.planner} | `
			+ `${document.openDecisions} | ${document.build} |`
		),
	].join("\n");
}

type Located =
	| { state: "absent" | "unchanged" }
	| { state: "refused"; reason: string; message?: string }
	| { state: "edit"; revision: number; operations: edit.Operation[] };

function locate(plan: DocumentRoom["plan"], body: string, create: boolean): Located {
	if (implementationActive(plan)) return { state: "refused", reason: "locked" };
	let blocks = edit.outline(plan);
	let heading = blocks.findIndex(block =>
		block.type === "heading" && block.preview.trim() === INDEX_HEADING
	);
	if (heading < 0 && !create) return { state: "absent" };
	let next = blocks[heading + 1];
	let owned = !!next && (next.type === "table" || next.preview.trim() === EMPTY);
	let operations: edit.Operation[] = heading < 0
		? [{ op: "insert_root", source: `## ${INDEX_HEADING}\n\n${body}\n` }]
		: owned
		? [{ op: "replace", index: heading + 1, source: `${body}\n` }]
		: [{ op: "insert", index: heading, source: `${body}\n` }];
	let prepared = edit.prepare(plan, plan.revision, operations);
	if (!prepared.ok) {
		return {
			state: "refused",
			reason: prepared.reason,
			...("message" in prepared ? { message: prepared.message } : {}),
		};
	}
	if (prepared.source === edit.source(plan)) return { state: "unchanged" };
	return { state: "edit", revision: plan.revision, operations };
}

/** Writes or refreshes `room`'s table of `documents`; with `create` false, only one already there. */
export async function writeIndex(
	room: DocumentRoom,
	documents: CreatedDocumentState[],
	create: boolean,
	signal?: AbortSignal,
): Promise<IndexOutcome> {
	let body = indexBody(documents);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (signal?.aborted) return { state: "refused", reason: "cancelled" };
		let located = await room.exclusive(async () => locate(room.plan, body, create));
		if (located.state !== "edit") return located;
		let args = { revision: located.revision, operations: located.operations };
		let refusal = await admitBlockEdit(room, args, signal);
		if (refusal) {
			if (refusal.reason === "stale") continue;
			return {
				state: "refused",
				reason: refusal.reason,
				...("message" in refusal && typeof refusal.message === "string"
					? { message: refusal.message }
					: {}),
			};
		}
		let result = await room.exclusive(() => applyBlockEdit(room, args, { signal }));
		if (result.ok) return { state: "written" };
		if (result.reason === "stale") continue;
		return {
			state: "refused",
			reason: result.reason,
			...("message" in result ? { message: result.message } : {}),
		};
	}
	return { state: "refused", reason: "stale" };
}
