/**
 * The authority on what a comment thread says and whether it is still open.
 *
 * Thinner than the questionnaire store, because notes are append-only. Nobody
 * is co-writing one sentence — they are each writing their own — so there is no
 * shared draft, no CRDT, and no revision to be stale against.
 *
 * Resolving changes only this record, never the document, so it needs no
 * claim: the record changes, the caller persists it, and only then is anyone
 * told. Reopening is the same in reverse.
 *
 * The durable half of a thread lives in the plan's record map. This owns the
 * parts that must not survive a restart: which threads resolved recently, and
 * who is typing.
 */

import { ulid } from "@chopin/dialect";

import type { Comment } from "@chopin/protocol";
import type { Record as Thread } from "./service";

/** How long a resolved thread is remembered, for a request that lost the race. */
const CLOSED_TTL = 5 * 60 * 1_000;

/**
 * Unresolved threads a plan may hold.
 *
 * A ceiling on open ones rather than on the total: resolved threads are the
 * record and are kept forever, while fifty unresolved ones say the room has
 * stopped resolving things, which is worth refusing on.
 */
export const MAX_OPEN = 50;

/** Notes in one thread, past which it is a conversation that belongs in chat. */
export const MAX_NOTES = 50;

type Ended = { status: Comment.Status; resolver: string };

type Closed = { result: Ended; expires: number };

export type Threads = {
	/** Tombstones, so arriving second reads as "they got there first". */
	closed: Map<string, Closed>;
	/** Thread to client to handle. Relayed, never stored. */
	typing: Map<string, Map<string, string>>;
};

export type Records = Map<string, Thread>;

/** Why a thread cannot be added to or resolved right now. */
export type Blocked =
	| { ok: false; reason: "missing"; message: string }
	| { ok: false; reason: "resolved"; status: Comment.Status; resolver: string };

export type Refusal = Blocked | { ok: false; reason: "full"; message: string };

export function create(): Threads {
	return { closed: new Map(), typing: new Map() };
}

function sweep(threads: Threads): void {
	let now = Date.now();
	for (let [id, entry] of threads.closed) {
		if (entry.expires <= now) threads.closed.delete(id);
	}
}

function settled(entry: Closed): Blocked {
	return {
		ok: false,
		reason: "resolved",
		status: entry.result.status,
		resolver: entry.result.resolver,
	};
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Find an open thread, or say why there is not one.
 *
 * A tombstone answers before a missing record does, because a thread somebody
 * resolved a moment ago is a different thing from one that never existed.
 */
function live(threads: Threads, records: Records, id: string): Thread | Blocked {
	let ended = threads.closed.get(id);
	if (ended) return settled(ended);

	let record = records.get(id);
	if (!record) return { ok: false, reason: "missing", message: "No such comment thread." };
	if (record.status !== "open") {
		return {
			ok: false,
			reason: "resolved",
			status: record.status,
			resolver: record.resolver ?? "system",
		};
	}
	return record;
}

function refused(value: Thread | Blocked): value is Blocked {
	return "ok" in value && value.ok === false;
}

export function note(handle: string, text: string): Comment.Note {
	return { id: ulid(), handle, text, ts: now() };
}

/** Threads that have not been resolved. */
export function open(records: Records): Thread[] {
	return [...records.values()].filter(record => record.status === "open");
}

/** Whether another thread may be started at all. */
export function room(records: Records): { ok: false; reason: "full"; message: string } | undefined {
	if (open(records).length < MAX_OPEN) return undefined;
	return {
		ok: false,
		reason: "full",
		message: `This plan already has ${MAX_OPEN} unresolved comments. Resolve some first.`,
	};
}

/** Add to an open thread. */
export function reply(
	threads: Threads,
	records: Records,
	id: string,
	handle: string,
	text: string,
): { ok: true; note: Comment.Note; thread: Thread } | Refusal {
	let record = live(threads, records, id);
	if (refused(record)) return record;

	if (record.notes.length >= MAX_NOTES) {
		return {
			ok: false,
			reason: "full",
			message: `A thread holds at most ${MAX_NOTES} comments.`,
		};
	}

	let added = note(handle, text);
	let next: Thread = { ...record, notes: [...record.notes, added] };
	records.set(id, next);
	return { ok: true, note: added, thread: next };
}

/**
 * Close an open thread.
 *
 * The quote is frozen here so the record keeps the prose as it read when
 * somebody resolved it, not as it reads after whatever happens next.
 */
export function resolve(
	threads: Threads,
	records: Records,
	id: string,
	resolver: string,
	quote: string,
): { ok: true; thread: Thread; previous: Thread } | Blocked {
	let record = live(threads, records, id);
	if (refused(record)) return record;

	threads.typing.delete(id);
	sweep(threads);
	threads.closed.set(id, {
		result: { status: "resolved", resolver },
		expires: Date.now() + CLOSED_TTL,
	});

	let next: Thread = { ...record, status: "resolved", resolver, at: now(), quote };
	records.set(id, next);
	return { ok: true, thread: next, previous: record };
}

/**
 * Open a resolved thread again.
 *
 * The tombstone goes too. `live` consults it before the record, so leaving it
 * would refuse every reply to the reopened thread until it expired.
 */
export function reopen(
	threads: Threads,
	records: Records,
	id: string,
):
	| { ok: true; thread: Thread; previous: Thread }
	| { ok: false; reason: "missing" | "open" | "settled"; message: string }
{
	let record = records.get(id);
	if (!record) return { ok: false, reason: "missing", message: "No such comment thread." };
	if (record.status === "open") {
		return { ok: false, reason: "open", message: "That thread is already open." };
	}
	if (record.status !== "resolved") {
		return { ok: false, reason: "settled", message: "That thread was decided and cannot reopen." };
	}

	threads.closed.delete(id);
	let next: Thread = { ...record, status: "open" };
	delete next.at;
	delete next.quote;
	delete next.resolver;
	records.set(id, next);
	return { ok: true, thread: next, previous: record };
}

/**
 * Put a record back as it was, when persisting its change failed.
 *
 * The tombstone follows the record, so a restored resolution still answers a
 * late reply with who resolved it.
 */
export function restore(threads: Threads, records: Records, previous: Thread): void {
	records.set(previous.id, previous);
	if (previous.status === "open") threads.closed.delete(previous.id);
	else {
		threads.closed.set(previous.id, {
			result: { status: previous.status, resolver: previous.resolver ?? "system" },
			expires: Date.now() + CLOSED_TTL,
		});
	}
}

/** Note that somebody is, or has stopped, writing a reply. */
export function typing(
	threads: Threads,
	id: string,
	client: string,
	handle: string,
	writing: boolean,
): void {
	if (!writing) {
		threads.typing.get(id)?.delete(client);
		return;
	}
	let entry = threads.typing.get(id);
	if (!entry) threads.typing.set(id, entry = new Map());
	entry.set(client, handle);
}

/** Drop a departed client from every thread it was writing in. */
export function away(threads: Threads, client: string): void {
	for (let entry of threads.typing.values()) entry.delete(client);
}
