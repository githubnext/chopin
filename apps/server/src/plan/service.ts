/**
 * The plan, as a room offers it.
 *
 * Sits between sockets and the authoritative document: batches incoming
 * updates, decides whether they may be applied, acknowledges the sender and
 * relays to everyone else, and keeps the disk snapshot current.
 *
 * Acknowledgement is the contract worth being careful about. A client is told
 * its update was accepted only once the document has taken it and still
 * validates, because an ack is what lets the client stop holding the bytes.
 */

import * as Y from "yjs";

import { MENTION } from "@chopin/protocol/address";

import * as presence from "./presence";
import * as room from "./room";
import * as snapshot from "./snapshot";
import * as Chat from "../chat/service";
import * as Comments from "../comments/service";
import * as Questions from "../questions/service";
import { broadcast, relay, reply, tell } from "../wire";

import type { Server } from "bun";
import type { Plan as Wire, Request } from "@chopin/protocol";
import type { Socket, SocketData } from "../wire";
import type { Presence } from "./presence";
import type { Document } from "./room";
import type * as edit from "./edit";
import type { Block } from "./edit";
import type { Sink } from "./snapshot";

/** Updates are grouped for this long before being applied together. */
const GROUP_MS = 5;

/** Per-connection ceiling, generous enough that typing never reaches it. */
const RATE_LIMIT = 200;
const RATE_WINDOW_MS = 1_000;

/** Invalid batches tolerated from one connection before it is disconnected. */
const INVALID_LIMIT = 3;
const INVALID_WINDOW_MS = 10 * 60 * 1_000;

/** Close code for a client that keeps sending updates the document rejects. */
const ABUSIVE = 4003;

type Queued = {
	ws: Socket;
	rid: string;
	id: string;
	update: Uint8Array;
};

type Meter = {
	/** Timestamps of recent updates, for the rate limit. */
	recent: number[];
	/** Timestamps of recent rejections, for the strike count. */
	invalid: number[];
};

export type Plan = {
	document: Document;
	presence: Presence;
	sink: Sink;
	/** Open questionnaires and their shared answer drafts. */
	questions: Questions.Questions;
	/** Resolutions in flight and who is typing. Nothing durable. */
	comments: Comments.Threads;
	/** The conversation driving the agent. */
	chat: Chat.Chat;
	/**
	 * Every questionnaire this plan has ever held, answered or not.
	 *
	 * Kept beside the document rather than in it: the plan shows a decision,
	 * this owns it. An agent rewriting the prose cannot change what was decided.
	 */
	records: Map<string, Questions.Record>;
	/**
	 * Every comment thread this plan has ever held.
	 *
	 * Beside the document for the same reason a questionnaire record is: a
	 * comment must not be undoable with the plan, and the agent must not be
	 * able to rewrite what somebody said about its work.
	 */
	threads: Map<string, Comments.Record>;
	/** Bumped on every committed change; the agent's concurrency token. */
	revision: number;
	/**
	 * Block outlines by revision.
	 *
	 * Kept so a batch aimed at a revision that has moved can be told which
	 * blocks moved, rather than only that it is too late.
	 */
	outlines: Map<number, Block[]>;
	queue: Queued[];
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Repeats the agent's cursor while it has one, so peers do not drop it. */
	attention: ReturnType<typeof setInterval> | undefined;
	/** Serialises commits so two batches cannot interleave. */
	flushing: Promise<void>;
	meters: WeakMap<Socket, Meter>;
};

function decode(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "base64"));
}

function encode(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

function recent(stamps: number[], window: number): number[] {
	let cutoff = Date.now() - window;
	return stamps.filter(at => at > cutoff);
}

/**
 * Bring a room's plan into being.
 *
 * Restores from disk when there is something to restore, and validates it on
 * the way in: unlike a database record, this file is one a person can open and
 * edit between runs, so it is not trusted just because we wrote it.
 */
export async function open(id: string, dir: string, server: Server<SocketData>): Promise<Plan> {
	let stored = await snapshot.load(dir);

	if (stored?.source) {
		try {
			room.validate(stored.source);
		} catch (err) {
			let message = err instanceof Error ? err.message : String(err);
			throw new Error(`${dir}/plan.mdx is not a valid plan: ${message}`, { cause: err });
		}
	}

	let document = await room.create(stored?.source ?? "", true);

	let plan: Plan = {
		document,
		presence: presence.create(),
		questions: Questions.create(),
		comments: Comments.create(),
		chat: Chat.restore(
			(stored?.state.transcript ?? []) as never[],
			stored?.state.session,
		),
		outlines: new Map(),
		records: new Map(
			(stored?.state.questions ?? []).map(record => [record.id, record as Questions.Record]),
		),
		threads: new Map(
			(stored?.state.threads ?? []).map(record => [record.id, record as Comments.Record]),
		),
		revision: stored?.state.revision ?? 0,
		queue: [],
		timer: undefined,
		attention: undefined,
		flushing: Promise.resolve(),
		meters: new WeakMap(),
		sink: snapshot.sink({
			dir,
			// Anchors and passages are expressed against the document, so they
			// are brought forward before being written rather than left to the
			// agent's next edit — which is what used to recover a moved block.
			//
			// A recovery nobody is told about is invisible: the highlight stays
			// dark until something else happens to broadcast. So the snapshot
			// is compared, and the room hears only when it actually moved.
			onFlush: () => {
				let before = signature(plan);
				Questions.rebase(plan);
				Comments.rebase(plan);
				if (signature(plan) !== before) anchors(plan, server, id);
			},
			read: () => ({
				source: room.project(plan.document),
				state: {
					revision: plan.revision,
					questions: [...plan.records.values()],
					threads: [...plan.threads.values()],
					transcript: plan.chat.entries,
					...(plan.chat.resume ? { session: plan.chat.resume } : {}),
				},
			}),
			onWrite(state, message) {
				broadcast(server, id, {
					kind: "plan:status",
					ts: 0,
					state,
					revision: plan.revision,
					...(message ? { message } : {}),
				});
			},
		}),
	};

	// A restart is an epoch rotation: every position restored from disk was
	// expressed in a history this document does not have. Recovering them now
	// rather than on the first write is what lets the client that joins one
	// millisecond later resolve anything at all.
	//
	// Guarded because this is the last thing between a room and being open. A
	// plan whose highlights are stale is worth having; one that refuses to open
	// because a decision could not be placed is not.
	try {
		Questions.rebase(plan);
		Comments.rebase(plan);
	} catch (err) {
		console.error(`[plan] could not carry anchors into ${id}:`, err);
	}

	return plan;
}

/** Cheap identity of the whole relationship snapshot, for spotting a change. */
function signature(plan: Plan): string {
	return JSON.stringify([Questions.anchors(plan), Comments.anchors(plan)]);
}

/** Everything a joining client needs to start from. */
export function greet(plan: Plan, ws: Socket, msg: Request<Wire.Open.Ask>): void {
	let resume = msg.epoch === plan.document.epoch && msg.vector ? decode(msg.vector) : undefined;
	let hello = presence.snapshot(plan.presence);

	reply(ws, msg.rid, {
		kind: "plan:open",
		ts: 0,
		epoch: plan.document.epoch,
		seq: plan.document.seq,
		update: encode(room.sync(plan.document, resume)),
		revision: plan.revision,
		anchors: Questions.anchors(plan),
		threads: Comments.anchors(plan),
		limits: room.LIMITS,
		...(hello ? { awareness: encode(hello) } : {}),
	});
}

function meter(plan: Plan, ws: Socket): Meter {
	let existing = plan.meters.get(ws);
	if (existing) return existing;
	let created: Meter = { recent: [], invalid: [] };
	plan.meters.set(ws, created);
	return created;
}

/** Accept an update for the next batch, or say why not. */
export function submit(plan: Plan, ws: Socket, msg: Request<Wire.Submit>): void {
	if (msg.epoch !== plan.document.epoch) {
		// Nothing to correct: the client is describing a history that no longer
		// exists and needs to re-open, which the reset already told it to do.
		return;
	}

	let update = decode(msg.update);
	if (update.byteLength > room.LIMITS.update) {
		return tell(ws, {
			kind: "plan:reset",
			ts: 0,
			epoch: plan.document.epoch,
			reason: "rebuilt",
		});
	}

	let gauge = meter(plan, ws);
	gauge.recent = recent(gauge.recent, RATE_WINDOW_MS);
	if (gauge.recent.length >= RATE_LIMIT) return;
	gauge.recent.push(Date.now());

	plan.queue.push({ ws, rid: msg.rid, id: msg.id, update });
	schedule(plan);
}

function schedule(plan: Plan): void {
	if (plan.timer) return;
	plan.timer = setTimeout(() => {
		plan.timer = undefined;
		plan.flushing = plan.flushing.then(() => commit(plan), () => commit(plan));
	}, GROUP_MS);
}

/**
 * Apply one batch.
 *
 * On rejection the document is rebuilt from its last known-good state and
 * everyone re-opens. Yjs cannot undo a transaction, so there is no narrower
 * remedy — which is why the senders in the batch are the ones charged for it.
 */
async function commit(plan: Plan): Promise<void> {
	let batch = plan.queue;
	if (batch.length === 0) return;
	plan.queue = [];

	let outcome = await room.apply(plan.document, batch.map(item => item.update));

	if (!outcome.ok) {
		console.warn("[plan] rejected batch:", outcome.issues.join(", "));

		let now = Date.now();
		for (let item of batch) {
			let gauge = meter(plan, item.ws);
			gauge.invalid = [...recent(gauge.invalid, INVALID_WINDOW_MS), now];
			if (gauge.invalid.length >= INVALID_LIMIT) {
				item.ws.close(ABUSIVE, "repeated invalid plan updates");
			}
		}

		let rebuilt = await room.rebuild(plan.document);
		plan.document = rebuilt;
		// Cursors describe positions in a history that no longer exists. The
		// agent's is in there too, and the interval repeating it would outlive
		// the presence it repeats.
		clearInterval(plan.attention);
		plan.attention = undefined;
		presence.destroy(plan.presence);
		plan.presence = presence.create();
		// So do anchors and passages, and unlike a cursor nobody re-announces
		// them. Without this every highlight in the room stays dark until the
		// agent happens to edit.
		//
		// Guarded because the `plan:reset` below is what tells everyone to
		// re-open. A throw here would strand the whole room on an epoch that no
		// longer exists, to save some highlights that are already stale.
		try {
			Questions.rebase(plan);
			Comments.rebase(plan);
		} catch (err) {
			console.error("[plan] could not carry anchors onto the rebuilt document:", err);
		}

		for (let item of batch) {
			tell(item.ws, { kind: "plan:reset", ts: 0, epoch: rebuilt.epoch, reason: "rebuilt" });
		}
		return;
	}

	plan.revision++;

	for (let item of batch) {
		reply(item.ws, item.rid, {
			kind: "plan:ack",
			ts: 0,
			epoch: plan.document.epoch,
			id: item.id,
			seq: outcome.seq,
		});
		// Peers need the bytes; the sender already applied them locally.
		relay(item.ws, {
			kind: "plan:update",
			ts: 0,
			epoch: plan.document.epoch,
			update: encode(item.update),
			seq: outcome.seq,
		});
	}

	room.mark(plan.document);
	plan.sink.touch();
}

/**
 * Relay a change the server made, as an ordinary update.
 *
 * Agent edits and answer projections reach clients the same way a keystroke
 * does: as a delta against the document they already hold. That is what keeps
 * an agent rewriting a paragraph from costing everybody else their cursor.
 */
export function publish(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	mutation: { update: Uint8Array; source: string },
): void {
	plan.document.seq++;
	plan.revision++;
	broadcast(server, roomId, {
		kind: "plan:update",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(mutation.update),
		seq: plan.document.seq,
	});
	room.mark(plan.document);
	plan.sink.touch();
}

/**
 * Relay what the agent just did, so a reader can be shown where.
 *
 * Indices become anchors here rather than in the edit engine: only the live
 * document can say where a block is in the collaborative history, and only
 * these survive somebody else editing between this frame being sent and the
 * browser painting it.
 *
 * Sent after the update that created the blocks it names, which is what makes
 * it resolvable at the other end. Guarded whole, and silent on failure: this
 * is decoration, and a room that dropped an edit over a mark nobody would
 * have noticed would be a poor trade.
 */
export function changes(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	found: edit.Change[],
): void {
	if (found.length === 0) return;

	try {
		let digests = room.digests(plan.document);
		let anchor = (index: number): Wire.Anchor | undefined => {
			let digest = digests[index];
			return digest === undefined ? undefined : room.anchorAt(plan.document, index, digest);
		};
		let gap = (spot: edit.Spot): Wire.Gap | undefined => {
			let at = anchor(spot.index);
			return at && { at, side: spot.side };
		};

		let wired: Wire.Change[] = [];
		for (let change of found) {
			if (change.kind === "removed") {
				let at = gap(change.at);
				if (at) wired.push({ kind: "removed", at, blocks: change.blocks });
				continue;
			}

			let at = anchor(change.index);
			if (!at) continue;
			if (change.kind === "added") {
				wired.push({ kind: "added", at, type: change.type, preview: change.preview });
				continue;
			}

			// Both ends or neither: a move shown only where it landed reads as
			// new prose, and shown only where it left reads as a deletion.
			let from = gap(change.from);
			if (from) {
				wired.push({ kind: "moved", at, from, type: change.type, preview: change.preview });
			}
		}

		if (wired.length === 0) return;
		broadcast(server, roomId, {
			kind: "plan:changes",
			ts: 0,
			epoch: plan.document.epoch,
			changes: wired,
		});

		// From the same anchoring pass, deliberately. Two passes could disagree
		// about where the edit was, and then the cursor would be pointing at
		// one block while the marks described another.
		let last = wired.at(-1)!;
		attend(plan, server, roomId, last.kind === "removed" ? last.at.at : last.at);
	} catch (err) {
		console.error("[plan] could not say what the agent changed:", err);
	}
}

/** Relay the current relationship snapshot to the whole room. */
export function anchors(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
): void {
	broadcast(server, roomId, {
		kind: "plan:anchors",
		ts: 0,
		epoch: plan.document.epoch,
		widgets: Questions.anchors(plan),
		threads: Comments.anchors(plan),
	});
}

/**
 * How often to repeat the agent's cursor.
 *
 * Comfortably inside the thirty seconds after which a peer drops a state it
 * has not heard about. Ours rather than the awareness library's, because a
 * cursor that quietly disappears partway through a long turn is not a failure
 * anybody would think to attribute to a renewal cadence changing underneath.
 */
const RENEW_MS = 10_000;

/**
 * The colour of the agent's cursor.
 *
 * A graphite, deliberately outside the palette `packages/editor/src/cursor.ts`
 * hands to people: the agent is not one of them, and a cursor that looked like
 * a colleague's would be read as one. Literal rather than a theme token
 * because Lexical validates it with `CSS.supports` and writes it inline, so a
 * `var()` would resolve against the wrong scope or not at all.
 *
 * Duplicated across the package boundary rather than shared for one string. If
 * the palette there ever grows a slate, this is what it must not collide with.
 */
const AGENT_COLOR = "#475569";

/**
 * Put the agent's cursor where it just edited.
 *
 * Presence rather than a record: it says the agent is working here now, which
 * is why it is broadcast rather than held, and why it does not wait to be
 * seen the way the marks do. Somebody scrolled elsewhere is not shown it at
 * all — that is what the marks and the chips are for.
 */
function attend(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	at: Wire.Anchor,
): void {
	// The last turn may still be counting down to taking the cursor away. It is
	// about to be somewhere new, so that removal is no longer the truth.
	clearTimeout(plan.chat.lingering);
	plan.chat.lingering = undefined;

	let position = Y.decodeRelativePosition(decode(at.position));
	let update = presence.attend(plan.presence, {
		name: MENTION.slice(1),
		color: AGENT_COLOR,
		focusing: true,
		agent: true,
		anchorPos: position,
		focusPos: position,
		awarenessData: {},
	});

	broadcast(server, roomId, {
		kind: "plan:awareness",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(update),
	});

	// Restarted, not stacked: an agent that edits twice in a turn should not
	// end up with two intervals repeating its cursor.
	clearInterval(plan.attention);
	plan.attention = setInterval(() => {
		let renewed = presence.renew(plan.presence);
		if (!renewed) return;
		broadcast(server, roomId, {
			kind: "plan:awareness",
			ts: 0,
			epoch: plan.document.epoch,
			update: encode(renewed),
		});
	}, RENEW_MS);
}

/** Take the agent's cursor down, and stop repeating it. */
export function release(plan: Plan, server: Server<SocketData>, roomId: string): void {
	clearInterval(plan.attention);
	plan.attention = undefined;

	let update = presence.release(plan.presence);
	if (!update) return;

	broadcast(server, roomId, {
		kind: "plan:awareness",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(update),
	});
}

/** Relay presence verbatim, and remember it for whoever joins next. */
export function awareness(plan: Plan, ws: Socket, msg: Wire.Awareness): void {
	if (msg.epoch !== plan.document.epoch) return;
	presence.track(plan.presence, ws, decode(msg.update));
	relay(ws, { kind: "plan:awareness", ts: 0, epoch: plan.document.epoch, update: msg.update });
}

/** Clear a departed member's cursors rather than leaving peers to time them out. */
export function departed(plan: Plan, ws: Socket): void {
	let update = presence.drop(plan.presence, ws);
	if (!update) return;
	relay(ws, {
		kind: "plan:awareness",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(update),
	});
}

/** Write anything outstanding and let go. */
export async function close(plan: Plan): Promise<void> {
	if (plan.timer) clearTimeout(plan.timer);
	clearInterval(plan.attention);
	await plan.flushing;
	await plan.sink.flush();
	await Chat.close(plan.chat);
	Questions.shutdown(plan.questions);
	presence.destroy(plan.presence);
	plan.document.doc.destroy();
}

/** Current canonical source. */
export function source(plan: Plan): string {
	return room.project(plan.document);
}

/** Size of the Yjs history, for the idle compaction check. */
export function size(plan: Plan): number {
	return Y.encodeStateAsUpdate(plan.document.doc).byteLength;
}
