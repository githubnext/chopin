/**
 * What the Chat shows of the Planner's queue: the same list for everyone in the room, with the
 * work nobody typed told in plain words and never as the prompt the Planner will read.
 */
import type { Chat as Wire, ConversationPlan } from "@chopin/protocol";

/** The parts of a queued turn the wire projection reads. */
export type Queued = {
	id: string;
	handle: string;
	text: string;
	references?: Wire.Reference[];
	/** Typed in the composer, or by an MCP caller as a member. */
	message?: boolean;
	thread?: string;
	draft?: string;
	job?: { job: { kind: ConversationPlan.JobKind } };
};

const JOBS: Record<ConversationPlan.JobKind, string> = {
	heading: "Refreshing the document's title",
	refine: "Preparing a decision suggestion",
	suggest: "Preparing a decision suggestion",
	prose: "Linking a decision to the document's text",
	"decision-followup": "Re-checking decisions against the document",
};

/** One waiting turn as clients see it. */
export function project(item: Queued): Wire.Waiting {
	if (item.job) {
		return { id: item.id, handle: item.handle, kind: "job", text: JOBS[item.job.job.kind] };
	}
	if (item.draft) {
		return { id: item.id, handle: item.handle, kind: "draft", text: "Draft of the build tasks" };
	}
	if (item.message) {
		return {
			id: item.id,
			handle: item.handle,
			text: item.text,
			...(item.references?.length ? { references: item.references } : {}),
		};
	}
	return item.thread
		? { id: item.id, handle: item.handle, kind: "comment", text: "Reply to a comment" }
		: { id: item.id, handle: item.handle, kind: "followup", text: "Automatic follow-up" };
}

/**
 * The references of a message that still stand once its text changes from `before` to `after`.
 *
 * A reference stays where the text around the edit is unchanged, moved by what the edit added or
 * removed before it. One the edit did not touch but could not be placed that way, because the
 * edit changed both ends of the message, follows its label to where it now reads, when that label
 * stands exactly once before and once after. A reference the edit touched is dropped, so what
 * remains still reads as the label it was resolved with.
 */
export function carryReferences(
	before: string,
	after: string,
	references: readonly Wire.Reference[] = [],
): Wire.Reference[] {
	let limit = Math.min(before.length, after.length);
	let head = 0;
	while (head < limit && before.charCodeAt(head) === after.charCodeAt(head)) head++;
	let tail = 0;
	while (
		tail < limit - head
		&& before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
	) tail++;
	let shift = after.length - before.length;
	let carried: Wire.Reference[] = [];
	let others: Wire.Reference[] = [];
	for (let reference of references) {
		let moved = reference.end <= head
			? reference
			: reference.start >= before.length - tail
			? { ...reference, start: reference.start + shift, end: reference.end + shift }
			: undefined;
		if (moved && after.slice(moved.start, moved.end) === moved.label) carried.push(moved);
		else others.push(reference);
	}
	for (let reference of others) {
		if (
			before.slice(reference.start, reference.end) === reference.label
			&& occurrences(before, reference.label) === 1 && occurrences(after, reference.label) === 1
		) {
			let start = after.indexOf(reference.label);
			carried.push({ ...reference, start, end: start + reference.label.length });
		}
	}
	// In order and apart, as a message's references are.
	let ordered: Wire.Reference[] = [];
	for (let reference of carried.sort((a, b) => a.start - b.start)) {
		if (reference.start >= (ordered.at(-1)?.end ?? 0)) ordered.push(reference);
	}
	return ordered;
}

function occurrences(text: string, part: string): number {
	let count = 0;
	for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++;
	return count;
}
