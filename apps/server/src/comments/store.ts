/**
 * The authority on what a comment thread says and whether it is still open.
 *
 * Thinner than the questionnaire store, because notes are append-only. Nobody
 * is co-writing one sentence — they are each writing their own — so there is no
 * shared draft, no CRDT, and no revision to be stale against.
 *
 * What is the same is the two-phase resolution. Accepting a thread has to
 * change the plan document as well as this record, and nobody may be told it is
 * final until both have happened. A claim reserves the outcome, the caller
 * performs the durable half, and only then does the commit make it visible.
 *
 * The durable half of a thread lives in the plan's record map. This owns the
 * parts that must not survive a restart: which resolutions are in flight, which
 * threads resolved recently, and who is typing.
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

export type Ended = {
	status: "accepted" | "dismissed";
	resolver: string;
	at: number;
	/** The marked prose as it read when this was decided. */
	quote: string;
};

type Closed = { result: Ended; expires: number };

export type Claim = { id: string; result: Ended };

export type Threads = {
	/** Resolutions in flight, so a rival claim is refused rather than raced. */
	claims: Map<string, "accept" | "dismiss">;
	/** Tombstones, so arriving second reads as "they got there first". */
	closed: Map<string, Closed>;
	/** Thread to client to handle. Relayed, never stored. */
	typing: Map<string, Map<string, string>>;
};

export type Records = Map<string, Thread>;

/** Why a thread cannot be added to or resolved right now. */
export type Blocked =
	| { ok: false; reason: "missing" | "resolving"; message: string }
	| { ok: false; reason: "resolved"; status: Comment.Status; resolver: string };

export type Refusal = Blocked | { ok: false; reason: "full"; message: string };

export function create(): Threads {
	return { claims: new Map(), closed: new Map(), typing: new Map() };
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
	if (threads.claims.has(id)) {
		return { ok: false, reason: "resolving", message: "That thread is being resolved." };
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
 * Reserve a resolution.
 *
 * The quote is frozen here rather than at commit, so the decision records the
 * prose as it read when somebody decided about it — not as it reads after
 * whatever the agent does next.
 */
export function claim(
	threads: Threads,
	records: Records,
	id: string,
	kind: "accept" | "dismiss",
	resolver: string,
	quote: string,
): { ok: true; claim: Claim; thread: Thread } | Blocked {
	let record = live(threads, records, id);
	if (refused(record)) return record;

	threads.claims.set(id, kind);
	return {
		ok: true,
		thread: record,
		claim: {
			id,
			result: {
				status: kind === "accept" ? "accepted" : "dismissed",
				resolver,
				at: now(),
				quote,
			},
		},
	};
}

/** Make a claimed resolution final. */
export function commit(threads: Threads, records: Records, entry: Claim): Thread | undefined {
	let record = records.get(entry.id);
	if (!record) return undefined;

	threads.claims.delete(entry.id);
	threads.typing.delete(entry.id);
	sweep(threads);
	threads.closed.set(entry.id, { result: entry.result, expires: Date.now() + CLOSED_TTL });

	let next: Thread = {
		...record,
		status: entry.result.status,
		resolver: entry.result.resolver,
		at: entry.result.at,
		quote: entry.result.quote,
	};
	records.set(entry.id, next);
	return next;
}

/** Undo a claim whose durable half failed. The thread stays open. */
export function rollback(threads: Threads, entry: Claim): void {
	threads.claims.delete(entry.id);
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
