/**
 * Comments, as a room offers them.
 *
 * A thread marks a phrase and collects what people said about it. Resolving one
 * hides it and reopening brings it back; neither touches the document, so each
 * is a record change that is persisted before anyone is told.
 *
 * A note can be sent to the Planner. That starts, or joins, a turn about the
 * thread; the Planner answers in the thread with `reply_comment`, and whatever
 * it writes in the plan is recorded as the thread's result. The wire's `to`
 * decides whether a note is addressed — never its text.
 *
 * Threads accepted under the earlier lifecycle keep their `<Decision>` and their
 * result anchors, and the agent still owes them a review. Nothing new becomes
 * accepted or dismissed.
 *
 * Where a thread points is not in these frames. A passage moves whenever the
 * plan does, and `plan:anchors` already carries every such relationship as one
 * authoritative snapshot, so putting it here too would be a second source of
 * truth updated on a different schedule.
 */

import { limits, ulid } from "@chopin/dialect";

import * as room from "../plan/room";
import * as Chat from "../chat/service";
import * as Store from "./store";
import { address } from "./prompt";
import { broadcast, fail, relay, reply, tell } from "../wire";

import * as Service from "../plan/service";

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
	 * Rebased with the plan while the thread is tracked, and never frozen: an
	 * accepted thread keeps its prose highlighted, so it has to keep knowing
	 * where that prose is. A resolved thread's passage is recovered on reopen.
	 */
	passage: Wired.Passage;
	notes: Wire.Note[];
	/**
	 * The prose the agent's revision produced. Absent until it anchors it, or
	 * until a turn sent this thread writes something.
	 */
	result?: Wired.AnchorSet;
	/** The marked text as it read when this resolved. Frozen; the passage is not. */
	quote?: string;
	resolver?: string;
	/** Unix seconds. */
	at?: number;
};

/** A record as it was stored before notes named their author. */
export function normalize(record: Record): Record {
	return { ...record, notes: record.notes.map(Store.normalize) };
}

/** The thread as clients see it. The passage travels on `plan:anchors`. */
function wire(record: Record, plan?: Plan): Wire.Thread {
	return {
		id: record.id,
		status: record.status,
		notes: record.notes,
		...(record.quote !== undefined ? { quote: record.quote } : {}),
		...(record.resolver ? { resolver: record.resolver } : {}),
		...(record.at !== undefined ? { at: record.at } : {}),
		...(plan && working(plan, record.id) ? { working: true } : {}),
	};
}

/**
 * Whether a Planner turn is running or waiting for this thread.
 *
 * Read from the turn and its queue rather than stored, so it cannot outlive
 * them: a restart drops both, and a thread that said otherwise would spin
 * for good.
 */
export function working(plan: Plan, id: string): boolean {
	let record = plan.threads.get(id);
	if (record?.status !== "open") return false;
	return plan.chat.acting === id || !!Chat.queuedFor(plan.chat, id);
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
 * Whether a thread still points into the document.
 *
 * Dismissed threads, and resolved threads that changed nothing, are hidden, so
 * nobody is shown where they point and their positions are not kept current.
 * A resolved thread recovers its passage from its relative positions and quote
 * when it is reopened. A resolved thread whose turn wrote something keeps
 * pointing at what it wrote, so the margin can still say so.
 */
function tracked(record: Record): boolean {
	if (record.status === "resolved") return !!record.result && record.result.anchors.length > 0;
	return record.status === "open" || record.status === "accepted";
}

/**
 * A thread's relationships, with an entry for one that has never been anchored.
 *
 * An accepted thread with no result is pending: the agent owes a review. An
 * open one is not — there is nothing outstanding until there is a decision.
 */
export function anchors(plan: Plan): Wired.ThreadAnchors[] {
	let out: Wired.ThreadAnchors[] = [];

	for (let record of plan.threads.values()) {
		if (!tracked(record)) continue;

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
		if (!tracked(record)) continue;

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
	if (!record || (record.status !== "accepted" && record.status !== "open")) return;
	if (record.status === "accepted" && record.result && !record.result.pending) return;
	if (blocks.length === 0) return;

	try {
		let current = room.digests(plan.document);
		// An open thread can be sent to the Planner more than once, and each
		// turn adds to what it produced rather than replacing it.
		let kept = record.status === "open" && record.result
			? record.result.anchors.filter(anchor => !anchor.orphaned)
			: [];
		let seen = new Set(kept.map(anchor => anchor.digest));
		let anchors: Wired.Anchor[] = [...kept];
		for (let index of blocks) {
			let hash = current[index];
			if (!hash || seen.has(hash)) continue;
			seen.add(hash);
			anchors.push(room.anchorAt(plan.document, index, hash));
		}
		if (anchors.length === kept.length) return;

		plan.threads.set(thread, { ...record, result: { anchors, pending: false } });
	} catch (err) {
		// A decision that cannot be pointed at is worse than one pointed at
		// coarsely, and both are better than a failed edit.
		console.error(`[comments] could not attribute a revision to ${thread}:`, err);
	}
}

/** Record the prose a thread's revision produced. */
export function relate(
	plan: Plan,
	thread: string,
	blocks: Array<{ index: number; digest: string }>,
): string | undefined {
	let record = plan.threads.get(thread);
	if (!record) return `no comment thread ${thread}`;
	if (record.status === "dismissed") return `comment thread ${thread} was dismissed`;

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
	// A thread sent to the Planner gathers what each of its turns produced. Only
	// an accepted thread's single revision is replaced outright.
	if (record.status !== "accepted" && record.result) {
		let seen = new Set(found.map(anchor => anchor.digest));
		let kept = record.result.anchors.filter(anchor => !anchor.orphaned && !seen.has(anchor.digest));
		found = [...kept, ...found];
	}
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
			.filter(tracked)
			.map(record => wire(record, plan)),
	});
}

function said(text: string): string | undefined {
	let value = text.trim();
	if (!value) return undefined;
	return value.length > limits.MAX_NOTE ? undefined : value;
}

/** How the Planner is reached, for a note sent to it. Absent for an ordinary note. */
export type Addressed = Chat.Room;

type Admitted = { planner?: Wire.Planner } | { refused: string };

/**
 * Whether a note sent to the Planner can be acted on, asked before it is saved.
 *
 * A full queue refuses the note rather than saving one nobody will act on. A
 * server without a Planner still takes it — it is a comment either way — and
 * says so.
 */
function admit(msg: { to?: unknown }, context: Addressed | undefined, thread?: string): Admitted {
	if (msg.to === undefined) return {};
	if (msg.to !== "planner" || !context) return { refused: "A comment can only be sent to Chopin." };
	let admitted = Chat.admission(context, thread);
	if (admitted === "busy") {
		return { refused: "Chopin has too much waiting already. Try again when it has caught up." };
	}
	return { planner: admitted };
}

/** Mark a phrase and say the first thing about it. */
export function start(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Start.Ask>,
	context?: Addressed,
): void | Promise<void> {
	let refuse = (reason: "invalid" | "full" | "busy", message: string) =>
		reply(ws, msg.rid, { kind: "comment:start", ts: 0, ok: false, reason, message });

	let full = Store.room(plan.threads);
	if (full) return refuse("full", full.message);

	let text = said(msg.text);
	if (!text) return refuse("invalid", "A comment needs something in it.");

	let admitted = admit(msg, context);
	if ("refused" in admitted) {
		return refuse(msg.to === "planner" ? "busy" : "invalid", admitted.refused);
	}

	let passage: Wired.Passage;
	try {
		passage = room.passageAt(plan.document, msg.blocks, msg.quote, msg.offset, msg.length);
	} catch (err) {
		return refuse("invalid", err instanceof Error ? err.message : "could not mark that passage");
	}

	let first = Store.note(ws.data.handle, text, admitted.planner ? "planner" : undefined);
	let record: Record = { id: ulid(), status: "open", passage, notes: [first] };
	plan.threads.set(record.id, record);
	let finish = async () => {
		reply(ws, msg.rid, {
			kind: "comment:start",
			ts: 0,
			ok: true,
			thread: wire(record),
			...(admitted.planner ? { planner: admitted.planner } : {}),
		});
		relay(ws, { kind: "comment:opened", ts: 0, thread: wire(record) });
		// The passage travels separately, and a card with nothing to highlight is
		// what the room sees until it arrives — so it goes now, not on the next edit.
		Service.anchors(plan, server, roomId);
		if (context && admitted.planner) await send(context, record.id, first);
	};
	return Service.persist(plan).then(finish);
}

/** Add to an open thread. */
export function respond(
	plan: Plan,
	ws: Socket,
	msg: Request<Wire.Reply.Ask>,
	context?: Addressed,
): void | Promise<void> {
	let refuse = (reason: "invalid" | "busy", message: string) =>
		reply(ws, msg.rid, { kind: "comment:reply", ts: 0, id: msg.id, ok: false, reason, message });

	let text = said(msg.text);
	if (!text) return refuse("invalid", "A comment needs something in it.");

	let admitted = admit(msg, context, msg.id);
	if ("refused" in admitted) {
		return refuse(msg.to === "planner" ? "busy" : "invalid", admitted.refused);
	}

	let outcome = Store.reply(
		plan.comments,
		plan.threads,
		msg.id,
		ws.data.handle,
		text,
		admitted.planner ? "planner" : undefined,
	);
	if (!outcome.ok) {
		return reply(ws, msg.rid, { kind: "comment:reply", ts: 0, id: msg.id, ...outcome });
	}

	Store.typing(plan.comments, msg.id, ws.data.client, ws.data.handle, false);
	let finish = async () => {
		reply(ws, msg.rid, {
			kind: "comment:reply",
			ts: 0,
			id: msg.id,
			ok: true,
			note: outcome.note,
			...(admitted.planner ? { planner: admitted.planner } : {}),
		});
		relay(ws, { kind: "comment:said", ts: 0, id: msg.id, note: outcome.note });
		if (context && admitted.planner) await send(context, msg.id, outcome.note);
	};
	return Service.persist(plan).then(finish);
}

/** Tell everyone whether the Planner is on a thread, and why it stopped if it did not finish. */
function announce(
	context: Pick<Addressed, "server" | "room">,
	id: string,
	working: boolean,
	reason?: Wire.Working["reason"],
): void {
	broadcast(context.server, context.room, {
		kind: "comment:working",
		ts: 0,
		id,
		working,
		...(reason ? { reason } : {}),
	});
}

/**
 * Hand a saved note to the Planner.
 *
 * Only after the note is durable and the room has it, so the turn never reads
 * a thread somebody else cannot see. A server without a Planner says so on the
 * thread rather than in Chat: the note is the thing that was asked about.
 */
async function send(context: Addressed, id: string, note: Wire.Note): Promise<void> {
	let { plan } = context;
	if (!context.config.agent) return announce(context, id, false, "off");

	let record = plan.threads.get(id);
	if (!record || record.status !== "open") return;
	let quote = reading(plan, record).quote;
	let handle = Store.speaker(note);
	// How many notes the turn could read when it began; set again if a folded turn starts.
	let seen = { notes: record.notes.length };
	try {
		await Chat.instruct(
			context,
			handle,
			address(plan.threads.get(id) ?? record, quote),
			`Comment on “${excerpt(quote)}” sent to Chopin`,
			{
				thread: id,
				// Resolved before its turn came round: nobody is waiting for it now.
				spent: () => plan.threads.get(id)?.status !== "open",
				started: () => {
					seen.notes = plan.threads.get(id)?.notes.length ?? 0;
				},
				ended: outcome => ended(context, id, outcome, seen.notes),
				comment: { thread: id, excerpt: excerpt(quote), note: note.text },
			},
		);
	} catch (err) {
		console.error("[comments] could not send a comment to the Planner:", err);
		return announce(context, id, working(plan, id), "failed");
	}
	// Only when a turn is now running or queued; a refusal already said why it is not.
	if (working(plan, id)) announce(context, id, true);
}

/**
 * The turn a thread was sent to has finished.
 *
 * If the Planner said something but never replied in the thread, its last word
 * in Chat is posted there for it: somebody asked in the thread, so the thread is
 * where they will look. Only when the thread is still open and nothing from the
 * Planner has followed the latest note sent to it.
 */
async function ended(
	context: Addressed,
	id: string,
	outcome: Chat.Ended,
	seen: number,
): Promise<void> {
	let { plan } = context;
	let record = plan.threads.get(id);
	let text = outcome.text?.trim().slice(0, limits.MAX_NOTE);
	// A note that arrived mid-turn is answered by the turn queued for it, not by
	// whatever this one last said about something else.
	let following = !!Chat.queuedFor(plan.chat, id);
	if (outcome.status === "done" && record?.status === "open" && text && !following) {
		let last = record.notes.slice(0, seen).findLastIndex(note => note.to === "planner");
		let answered = record.notes.slice(last + 1).some(note => note.author === "planner");
		if (!answered) {
			await post(plan, context.server, context.room, id, text).catch(err => {
				console.error("[comments] could not post the Planner's reply:", err);
			});
		}
	}

	let still = !!Chat.queuedFor(plan.chat, id);
	let reason = outcome.status === "stopped"
		? "stopped" as const
		: outcome.status === "failed"
		? "failed" as const
		: undefined;
	announce(context, id, still, still ? undefined : reason);
}

/** Add the Planner's note to an open thread, durably, then tell the room. */
async function post(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	text: string,
): Promise<{ ok: true; note: Wire.Note } | Store.Refusal> {
	let outcome = Store.append(plan.comments, plan.threads, id, Store.answer(text));
	if (!outcome.ok) return outcome;
	try {
		await Service.persist(plan);
	} catch (err) {
		Store.restore(plan.comments, plan.threads, outcome.previous);
		throw err;
	}
	broadcast(server, roomId, { kind: "comment:said", ts: 0, id, note: outcome.note });
	return { ok: true, note: outcome.note };
}

/**
 * The Planner answers in a thread.
 *
 * Only the thread its running turn was sent: a turn has no business speaking in
 * a conversation nobody asked it into, and one about a thread resolved since is
 * refused like any other late reply.
 */
export async function answer(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	thread: string,
	text: string,
): Promise<{ ok: true; note: string } | { ok: false; reason: string; message: string }> {
	if (plan.chat.acting !== thread) {
		return {
			ok: false,
			reason: "not-asked",
			message: "You can only reply in the comment thread this turn was sent.",
		};
	}
	let value = said(text);
	if (!value) {
		return {
			ok: false,
			reason: "invalid",
			message: `A reply needs text, at most ${limits.MAX_NOTE} characters.`,
		};
	}
	let outcome = await post(plan, server, roomId, thread, value);
	if (outcome.ok) return { ok: true, note: outcome.note.id };
	return outcome.reason === "resolved"
		? { ok: false, reason: "resolved", message: "The thread was resolved; nobody is waiting." }
		: { ok: false, reason: outcome.reason, message: outcome.message };
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

/**
 * Close a thread.
 *
 * Nothing about the document changes, so the record is the whole of it: change
 * it, persist it, and only then answer and tell the room. A failed write puts
 * the thread back as it was and tells nobody but the sender.
 */
export async function resolve(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Resolve.Ask>,
): Promise<void> {
	let held = plan.threads.get(msg.id);
	let quote = held?.status === "open" ? reading(plan, held).quote : "";

	let outcome = Store.resolve(plan.comments, plan.threads, msg.id, ws.data.handle, quote);
	if (!outcome.ok) {
		return reply(ws, msg.rid, { kind: "comment:resolve", ts: 0, id: msg.id, ...outcome });
	}

	try {
		await Service.persist(plan);
	} catch (err) {
		Store.restore(plan.comments, plan.threads, outcome.previous);
		console.error("[comments] could not save a resolved thread:", err);
		return fail(ws, msg.rid, "could not resolve the comment");
	}

	let { at = 0, resolver = ws.data.handle } = outcome.thread;
	reply(ws, msg.rid, { kind: "comment:resolve", ts: 0, id: msg.id, ok: true, resolver, at });
	broadcast(server, roomId, {
		kind: "comment:resolved",
		ts: 0,
		id: msg.id,
		status: "resolved",
		resolver,
		at,
		quote,
	});
	Service.anchors(plan, server, roomId);
}

/**
 * Open a resolved thread again.
 *
 * Its passage was not rebased while it was resolved, so it is brought forward
 * now, before the room is told where it points.
 */
export async function reopen(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Reopen.Ask>,
): Promise<void> {
	let outcome = Store.reopen(plan.comments, plan.threads, msg.id);
	if (!outcome.ok) {
		return reply(ws, msg.rid, { kind: "comment:reopen", ts: 0, id: msg.id, ...outcome });
	}

	let record: Record = {
		...outcome.thread,
		passage: room.rebasePassage(plan.document, outcome.thread.passage),
	};
	plan.threads.set(record.id, record);

	try {
		await Service.persist(plan);
	} catch (err) {
		Store.restore(plan.comments, plan.threads, outcome.previous);
		console.error("[comments] could not save a reopened thread:", err);
		return fail(ws, msg.rid, "could not reopen the comment");
	}

	reply(ws, msg.rid, { kind: "comment:reopen", ts: 0, id: msg.id, ok: true, thread: wire(record) });
	broadcast(server, roomId, { kind: "comment:reopened", ts: 0, thread: wire(record) });
	Service.anchors(plan, server, roomId);
}

/** Enough of the passage to recognise it in a line of transcript. */
export function excerpt(quote: string): string {
	let value = quote.replace(/\s+/g, " ").trim();
	if (value.length <= 60) return value;
	let cut = value.slice(0, 60);
	// Back up to a word boundary unless that would discard most of the excerpt.
	let boundary = value[60] === " " ? 60 : cut.lastIndexOf(" ");
	return `${(boundary > 30 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}
