/**
 * Comments, as a room offers them.
 *
 * A thread marks a phrase and collects what people said about it. Accepting one
 * is the room deciding: the thread freezes, a `<Decision>` goes into the plan,
 * and the agent is asked to revise the prose. Dismissing closes it without the
 * agent.
 *
 * Accepting is two-phase for the same reason answering a questionnaire is — the
 * record and the document both have to change, and nobody may be told it is
 * final until both have. If the document write fails the claim is rolled back
 * and the thread is still open, which every client already knows how to render.
 *
 * Where a thread points is not in these frames. A passage moves whenever the
 * plan does, and `plan:anchors` already carries every such relationship as one
 * authoritative snapshot, so putting it here too would be a second source of
 * truth updated on a different schedule.
 */

import { limits, ulid } from "@chopin/dialect";

import * as room from "../plan/room";
import * as Store from "./store";
import { broadcast, relay, reply, tell } from "../wire";

import * as Chat from "../chat/service";
import * as Service from "../plan/service";
import { compose } from "./prompt";

import type { Server } from "bun";
// `Plan` is the room's plan here; the protocol namespace of the same name is
// aliased so the two cannot be confused at a glance.
import type { Comment as Wire, Plan as Wired, Request } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

export type { Threads } from "./store";

export const create = Store.create;

/** A comment thread as it is stored beside the plan, so it survives a restart. */
export type Record = {
	id: string;
	status: Wire.Status;
	/**
	 * The phrase it marks.
	 *
	 * Rebased with the plan and never frozen: an accepted thread keeps its
	 * prose highlighted, so it has to keep knowing where that prose is.
	 */
	passage: Wired.Passage;
	notes: Wire.Note[];
	/** The prose the agent's revision produced. Absent until it anchors it. */
	result?: Wired.AnchorSet;
	/** The marked text as it read when this resolved. Frozen; the passage is not. */
	quote?: string;
	resolver?: string;
	/** Unix seconds. */
	at?: number;
};

/** The thread as clients see it. The passage travels on `plan:anchors`. */
function wire(record: Record): Wire.Thread {
	return {
		id: record.id,
		status: record.status,
		notes: record.notes,
		...(record.quote !== undefined ? { quote: record.quote } : {}),
		...(record.resolver ? { resolver: record.resolver } : {}),
		...(record.at !== undefined ? { at: record.at } : {}),
	};
}

/**
 * What the passage reads as right now.
 *
 * Rebasing is how that question is answered: it resolves the positions and
 * re-cuts the quote from the text they now cover. The rebased passage is kept,
 * because having computed it there is no reason to store the older one. A
 * drifted passage answers with what it last read, which is the best anyone can
 * say about prose that is gone.
 */
function reading(plan: Plan, record: Record): { quote: string; record: Record } {
	let passage = room.rebasePassage(plan.document, record.passage);
	let next: Record = { ...record, passage };
	plan.threads.set(record.id, next);
	return { quote: passage.quote, record: next };
}

// -- relationships ---------------------------------------------------------

/**
 * A thread's relationships, with an entry for one that has never been anchored.
 *
 * An accepted thread with no result is pending: the agent owes a review. An
 * open one is not — there is nothing outstanding until there is a decision.
 */
export function anchors(plan: Plan): Wired.ThreadAnchors[] {
	let out: Wired.ThreadAnchors[] = [];

	for (let record of plan.threads.values()) {
		// Dismissed threads are not shown and never reach the agent, so there
		// is nothing for anyone to point at.
		if (record.status === "dismissed") continue;

		let accepted = record.status === "accepted";
		out.push({
			thread: record.id,
			subject: record.passage,
			result: record.result ?? {
				anchors: [],
				pending: accepted,
				...(accepted ? { reason: "missing" as const } : {}),
			},
		});
	}

	return out;
}

/** Bring every thread forward onto the document as it is now. */
export function rebase(plan: Plan): void {
	for (let [id, record] of plan.threads) {
		if (record.status === "dismissed") continue;

		let next: Record = {
			...record,
			passage: room.rebasePassage(plan.document, record.passage),
		};

		if (record.result) {
			let moved = room.rebase(plan.document, record.result.anchors);
			let lost = moved.some(anchor => anchor.orphaned);
			next.result = {
				...record.result,
				anchors: moved,
				...(lost ? { pending: true, reason: "orphaned" as const } : {}),
			};
		}

		plan.threads.set(id, next);
	}
}

/**
 * Mark every result as needing review.
 *
 * The passage a decision produced is the thing most likely to have been
 * rewritten, and a link to where it used to be is worse than an admission that
 * nobody has checked.
 */
export function invalidate(plan: Plan, reason: Wired.AnchorReason): void {
	for (let [id, record] of plan.threads) {
		if (record.status !== "accepted" || !record.result) continue;
		plan.threads.set(id, {
			...record,
			result: { ...record.result, pending: true, reason },
		});
	}
}

/** Everything the agent still owes a review on. */
export function outstanding(plan: Plan): Array<{ thread: string; reason: Wired.AnchorReason }> {
	let out: Array<{ thread: string; reason: Wired.AnchorReason }> = [];

	for (let record of plan.threads.values()) {
		if (record.status !== "accepted") continue;
		if (record.result && !record.result.pending) continue;
		out.push({ thread: record.id, reason: record.result?.reason ?? "missing" });
	}

	return out;
}

/** Whether an accepted thread has already been acted on and anchored. */
export function applied(plan: Plan, id: string): boolean {
	let record = plan.threads.get(id);
	return !!record?.result && !record.result.pending;
}

/** Record the prose an accepted thread's revision produced. */
export function relate(
	plan: Plan,
	thread: string,
	blocks: Array<{ index: number; digest: string }>,
): string | undefined {
	let record = plan.threads.get(thread);
	if (!record) return `no comment thread ${thread}`;
	if (record.status !== "accepted") return `comment thread ${thread} was not accepted`;

	let current = room.digests(plan.document);
	let found: Wired.Anchor[] = [];

	for (let block of blocks) {
		let hash = current[block.index];
		if (!hash) return `no block at index ${block.index}`;
		if (hash !== block.digest) return `block ${block.index} has changed; read the plan again`;
		found.push(room.anchorAt(plan.document, block.index, hash));
	}

	// An empty list is a real answer: reviewed, and deliberately related to
	// nothing. It is not the same as never having looked.
	plan.threads.set(thread, { ...record, result: { anchors: found, pending: false } });
	return undefined;
}

// -- sockets ---------------------------------------------------------------

/** Every thread worth showing, for somebody who has just arrived. */
export function greet(plan: Plan, ws: Socket): void {
	tell(ws, {
		kind: "comment:sync",
		ts: 0,
		threads: [...plan.threads.values()]
			.filter(record => record.status !== "dismissed")
			.map(wire),
	});
}

function said(text: string): string | undefined {
	let value = text.trim();
	if (!value) return undefined;
	return value.length > limits.MAX_NOTE ? undefined : value;
}

/** Mark a phrase and say the first thing about it. */
export function start(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Start.Ask>,
): void {
	let refuse = (reason: "invalid" | "full", message: string) =>
		reply(ws, msg.rid, { kind: "comment:start", ts: 0, ok: false, reason, message });

	let full = Store.room(plan.threads);
	if (full) return refuse("full", full.message);

	let text = said(msg.text);
	if (!text) return refuse("invalid", "A comment needs something in it.");

	let passage: Wired.Passage;
	try {
		passage = room.passageAt(plan.document, msg.blocks, msg.quote, msg.offset, msg.length);
	} catch (err) {
		return refuse("invalid", err instanceof Error ? err.message : "could not mark that passage");
	}

	let record: Record = {
		id: ulid(),
		status: "open",
		passage,
		notes: [Store.note(ws.data.handle, text)],
	};
	plan.threads.set(record.id, record);
	plan.sink.touch();

	reply(ws, msg.rid, { kind: "comment:start", ts: 0, ok: true, thread: wire(record) });
	relay(ws, { kind: "comment:opened", ts: 0, thread: wire(record) });
	// The passage travels separately, and a card with nothing to highlight is
	// what the room sees until it arrives — so it goes now, not on the next edit.
	Service.anchors(plan, server, roomId);
}

/** Add to an open thread. */
export function respond(plan: Plan, ws: Socket, msg: Request<Wire.Reply.Ask>): void {
	let text = said(msg.text);
	if (!text) {
		return reply(ws, msg.rid, {
			kind: "comment:reply",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "invalid",
			message: "A comment needs something in it.",
		});
	}

	let outcome = Store.reply(plan.comments, plan.threads, msg.id, ws.data.handle, text);
	if (!outcome.ok) {
		return reply(ws, msg.rid, { kind: "comment:reply", ts: 0, id: msg.id, ...outcome });
	}

	Store.typing(plan.comments, msg.id, ws.data.client, ws.data.handle, false);
	plan.sink.touch();

	reply(ws, msg.rid, { kind: "comment:reply", ts: 0, id: msg.id, ok: true, note: outcome.note });
	relay(ws, { kind: "comment:said", ts: 0, id: msg.id, note: outcome.note });
}

/** Somebody is, or has stopped, writing a reply. */
export function typing(plan: Plan, ws: Socket, msg: Wire.Typing.Input): void {
	Store.typing(plan.comments, msg.id, ws.data.client, ws.data.handle, msg.writing);
	relay(ws, {
		kind: "comment:typing",
		ts: 0,
		id: msg.id,
		writing: msg.writing,
		client: ws.data.client,
		handle: ws.data.handle,
	});
}

/** Drop a departed member from every thread they were writing in. */
export function away(plan: Plan, ws: Socket): void {
	Store.away(plan.comments, ws.data.client);
}

type Resolution = "accept" | "dismiss";

/** Both resolutions answer with the same shape; only the kind differs. */
type Settled =
	| { ok: true; resolver: string; at: number }
	| { ok: false; reason: "missing" | "resolving" | "invalid"; message: string }
	| { ok: false; reason: "resolved"; status: Wire.Status; resolver: string };

function answer(ws: Socket, rid: string, kind: Resolution, id: string, body: Settled): void {
	if (kind === "accept") {
		return reply(ws, rid, { kind: "comment:accept", ts: 0, id, ...body });
	}
	reply(ws, rid, { kind: "comment:dismiss", ts: 0, id, ...body });
}

/**
 * Close a thread.
 *
 * Accepting has a durable half — the `<Decision>` node — so it is claimed
 * first, written, and only then committed. Dismissing has none: nothing about
 * the plan changes, so there is nothing to roll back.
 */
async function settle(
	context: Chat.Room,
	ws: Socket,
	msg: Request<Wire.Accept.Ask | Wire.Dismiss.Ask>,
	kind: Resolution,
): Promise<void> {
	let { plan, room: roomId, server } = context;

	let held = plan.threads.get(msg.id);
	// Read the passage before claiming: a decision records the prose as it read
	// when somebody decided about it, not as it reads after the agent acts.
	let quote = held ? reading(plan, held).quote : "";

	let claimed = Store.claim(plan.comments, plan.threads, msg.id, kind, ws.data.handle, quote);
	if (!claimed.ok) return answer(ws, msg.rid, kind, msg.id, claimed);

	if (kind === "accept") {
		let mutation: { update: Uint8Array; source: string } | undefined;

		try {
			mutation = room.insertDecision(plan.document, {
				id: msg.id,
				quote: quote.slice(0, limits.MAX_QUOTE),
				by: ws.data.handle,
				at: new Date(claimed.claim.result.at * 1_000).toISOString(),
				notes: claimed.thread.notes.map(note => ({ by: note.handle, text: note.text })),
			});
		} catch (err) {
			// The decision is not final if the plan could not be told about it.
			Store.rollback(plan.comments, claimed.claim);
			console.error("[comments] could not project a decision:", err);
			return answer(ws, msg.rid, kind, msg.id, {
				ok: false,
				reason: "invalid",
				message: err instanceof Error ? err.message : "could not record the decision",
			});
		}

		/*
		 * Past here the document holds the decision, so committing is no longer
		 * optional. Rolling back on a failed broadcast would leave a
		 * `<Decision>` in the plan whose record still says the thread is open —
		 * and the next accept would append a second node carrying the same id.
		 * A relay nobody received is recoverable; clients resync on the next
		 * update. A record disagreeing with the document is not.
		 */
		if (mutation) {
			try {
				Service.publish(plan, server, roomId, mutation);
			} catch (err) {
				console.error("[comments] could not relay a decision:", err);
			}
		}
	}

	let next = Store.commit(plan.comments, plan.threads, claimed.claim);
	plan.sink.touch();

	let { at, resolver } = claimed.claim.result;
	answer(ws, msg.rid, kind, msg.id, { ok: true, resolver, at });
	broadcast(server, roomId, {
		kind: "comment:resolved",
		ts: 0,
		id: msg.id,
		status: claimed.claim.result.status,
		resolver,
		at,
		quote,
	});
	Service.anchors(plan, server, roomId);

	if (kind === "accept" && next) {
		Chat.instruct(
			context,
			resolver,
			compose(next, quote),
			`@${resolver} accepted a comment on "${excerpt(quote)}".`,
			// Somebody else's turn may get to it first; running this one then
			// would only have the agent read the plan and find nothing to do.
			() => applied(plan, msg.id),
		);
	} else if (kind === "dismiss") {
		Chat.notice(context, `@${resolver} dismissed a comment on "${excerpt(quote)}".`);
	}
}

/** Enough of the passage to recognise it in a line of transcript. */
function excerpt(quote: string): string {
	let value = quote.replace(/\s+/g, " ").trim();
	return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

export function accept(context: Chat.Room, ws: Socket, msg: Request<Wire.Accept.Ask>) {
	return settle(context, ws, msg, "accept");
}

export function dismiss(context: Chat.Room, ws: Socket, msg: Request<Wire.Dismiss.Ask>) {
	return settle(context, ws, msg, "dismiss");
}
