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
 * stands exactly once before and once after. A reference the edit touched, or ran into the word
 * beside it, is dropped, so what remains still reads as the label it was resolved with.
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
		if (
			moved && after.slice(moved.start, moved.end) === moved.label
			&& !joined(before, reference, after, moved)
		) carried.push(moved);
		else others.push(reference);
	}
	for (let reference of others) {
		if (
			before.slice(reference.start, reference.end) !== reference.label
			|| occurrences(before, reference.label) !== 1
			|| occurrences(after, reference.label) !== 1
		) continue;
		let start = after.indexOf(reference.label);
		let moved = { ...reference, start, end: start + reference.label.length };
		if (!joined(before, reference, after, moved)) carried.push(moved);
	}
	// In order and apart, as a message's references are.
	let ordered: Wire.Reference[] = [];
	for (let reference of carried.sort((a, b) => a.start - b.start)) {
		if (reference.start >= (ordered.at(-1)?.end ?? 0)) ordered.push(reference);
	}
	return ordered;
}

/**
 * Whether the edit joined the label to the word beside it, as "#Doc" and "s" make "#Docs": a label
 * that ran into its neighbour when it was resolved is not blamed on the edit.
 */
function joined(
	before: string,
	was: Pick<Wire.Reference, "start" | "end">,
	after: string,
	now: Pick<Wire.Reference, "start" | "end">,
): boolean {
	return touching(after, now) && !touching(before, was);
}

function touching(text: string, at: Pick<Wire.Reference, "start" | "end">): boolean {
	let word = /[\p{L}\p{N}_]/u;
	return word.test(text.slice(Math.max(0, at.start - 1), at.start))
		|| word.test(text.slice(at.end, at.end + 1));
}

function occurrences(text: string, part: string): number {
	let count = 0;
	for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++;
	return count;
}
