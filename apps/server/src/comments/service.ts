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

/**
 * Record what a turn wrote as the decision it was asked to act on.
 *
 * The agent is told to say this itself with `anchor_plan`, and when it does
 * that answer is better than this one: it can pick out the two blocks of five
 * that actually came from the decision. But a thread whose result is never
 * anchored points at nothing for good, and the prose it was about is gone by
 * then — rewriting it is what acceptance asked for. So the blocks a turn
 * authored stand in until the agent says otherwise.
 *
 * Not pending: anchors derived from the change itself are as fresh as anchors
 * get. Only applied when nothing trustworthy is already there, so a precise
 * answer from a previous turn is never coarsened by a later guess.
 */
export function attribute(plan: Plan, thread: string, blocks: number[]): void {
	let record = plan.threads.get(thread);
	if (!record || record.status !== "accepted") return;
	if (record.result && !record.result.pending) return;
	if (blocks.length === 0) return;

	try {
		let current = room.digests(plan.document);
		let anchors: Wired.Anchor[] = [];
		for (let index of blocks) {
			let hash = current[index];
			if (hash) anchors.push(room.anchorAt(plan.document, index, hash));
		}
		if (anchors.length === 0) return;

		plan.threads.set(thread, { ...record, result: { anchors, pending: false } });
	} catch (err) {
		// A decision that cannot be pointed at is worse than one pointed at
		// coarsely, and both are better than a failed edit.
		console.error(`[comments] could not attribute a revision to ${thread}:`, err);
	}
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
): void | Promise<void> {
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
	let finish = () => {
		reply(ws, msg.rid, { kind: "comment:start", ts: 0, ok: true, thread: wire(record) });
		relay(ws, { kind: "comment:opened", ts: 0, thread: wire(record) });
		// The passage travels separately, and a card with nothing to highlight is
		// what the room sees until it arrives — so it goes now, not on the next edit.
		Service.anchors(plan, server, roomId);
	};
	return Service.persist(plan).then(finish);
}

/** Add to an open thread. */
export function respond(
	plan: Plan,
	ws: Socket,
	msg: Request<Wire.Reply.Ask>,
): void | Promise<void> {
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
	let finish = () => {
		reply(ws, msg.rid, { kind: "comment:reply", ts: 0, id: msg.id, ok: true, note: outcome.note });
		relay(ws, { kind: "comment:said", ts: 0, id: msg.id, note: outcome.note });
	};
	return Service.persist(plan).then(finish);
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
	let mutationError: unknown;
	let next: ReturnType<typeof Store.commit>;
	await Service.exclusive(plan, async () => {
		let mutation: { update: Uint8Array; source: string } | undefined;
		if (kind === "accept") {
			try {
				mutation = room.insertDecision(plan.document, {
					id: msg.id,
					quote: quote.slice(0, limits.MAX_QUOTE),
					by: ws.data.handle,
					at: new Date(claimed.claim.result.at * 1_000).toISOString(),
					notes: claimed.thread.notes.map(note => ({ by: note.handle, text: note.text })),
				});
			} catch (err) {
				mutationError = err;
				return;
			}
		}
		next = Store.commit(plan.comments, plan.threads, claimed.claim);
		if (mutation) await Service.publish(plan, server, roomId, mutation);
		else await Service.persistExclusive(plan);
	});
	if (mutationError) {
		Store.rollback(plan.comments, claimed.claim);
		console.error("[comments] could not project a decision:", mutationError);
		return answer(ws, msg.rid, kind, msg.id, {
			ok: false,
			reason: "invalid",
			message: mutationError instanceof Error
				? mutationError.message
				: "could not record the decision",
		});
	}

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
		await Chat.instruct(
			context,
			resolver,
			compose(next, quote),
			`@${resolver} accepted a comment on "${excerpt(quote)}".`,
			{
				// Somebody else's turn may get to it first; running this one
				// then would only have the agent read the plan and find
				// nothing to do.
				spent: () => applied(plan, msg.id),
				// So the prose the turn writes can be recorded as what this
				// decision produced, whether or not the agent says so.
				thread: msg.id,
			},
		);
	} else if (kind === "dismiss") {
		await Chat.notice(context, `@${resolver} dismissed a comment on "${excerpt(quote)}".`);
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
