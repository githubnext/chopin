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
import { createHash } from "node:crypto";

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
import type { JsonValue, Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

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

export type HostedBackend = {
	kind: "hosted";
	storage: StorageAdapter;
	lease: () => Lease;
	fatal: (error: unknown) => void;
};

type Durable = HostedBackend & {
	channelId: string;
	revision: number;
	sequence: number;
	lastSidecar: string;
	checkpointTimer: ReturnType<typeof setTimeout> | undefined;
	committedEpoch: string;
	committedSource: string;
	committedDocument: Uint8Array;
	committedSidecar: JsonValue;
	closing: boolean;
};

type Captured = {
	epoch: string;
	source: string;
	document: Uint8Array;
	sidecar: JsonValue;
	sidecarText: string;
};

export type Plan = {
	id: string;
	server: Server<SocketData>;
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
	/** Present only for authenticated channels; legacy rooms keep their files. */
	durable?: Durable;
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

function state(plan: Plan): snapshot.State {
	return {
		version: 1,
		revision: plan.revision,
		documentSeq: plan.document.seq,
		questions: [...plan.records.values()],
		openQuestions: Questions.dump(plan.questions),
		threads: [...plan.threads.values()],
		transcript: plan.chat.entries,
		...(plan.chat.resume ? { session: plan.chat.resume } : {}),
	};
}

function jsonState(plan: Plan): { value: JsonValue; text: string } {
	let text = JSON.stringify(state(plan));
	return { value: JSON.parse(text) as JsonValue, text };
}

function capture(plan: Plan): Captured {
	let sidecar = jsonState(plan);
	return {
		epoch: plan.document.epoch,
		source: room.project(plan.document),
		document: Y.encodeStateAsUpdate(plan.document.doc),
		sidecar: sidecar.value,
		sidecarText: sidecar.text,
	};
}

function objects(value: JsonValue[], label: string): Array<Record<string, JsonValue>> {
	let seen = new Set<string>();
	return value.map(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`hosted channel has an invalid ${label}`);
		}
		let item = entry as Record<string, JsonValue>;
		if (typeof item.id !== "string" || !item.id || seen.has(item.id)) {
			throw new Error(`hosted channel has an invalid or duplicate ${label} id`);
		}
		seen.add(item.id);
		return item;
	});
}

function restoredState(value: JsonValue, pristine: boolean): snapshot.State {
	if (value === null && pristine) {
		return {
			version: 1,
			revision: 0,
			documentSeq: 0,
			questions: [],
			openQuestions: [],
			threads: [],
			transcript: [],
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("hosted channel has an invalid sidecar");
	}
	let item = value as Record<string, JsonValue>;
	if (
		item.version !== 1
		|| typeof item.revision !== "number"
		|| !Number.isSafeInteger(item.revision)
		|| item.revision < 0
		|| typeof item.documentSeq !== "number"
		|| !Number.isSafeInteger(item.documentSeq)
		|| item.documentSeq < 0
		|| !Array.isArray(item.questions)
		|| !Array.isArray(item.openQuestions)
		|| !Array.isArray(item.threads)
		|| !Array.isArray(item.transcript)
	) throw new Error("hosted channel has an invalid sidecar");
	let questions = objects(item.questions, "question record");
	for (let question of questions) {
		if (
			(question.status !== "open" && question.status !== "answered"
				&& question.status !== "cancelled")
			|| !question.definition
			|| typeof question.definition !== "object"
			|| Array.isArray(question.definition)
		) throw new Error("hosted channel has an invalid question record");
	}
	let openQuestions = objects(item.openQuestions, "open questionnaire");
	let openIds = new Set(openQuestions.map(entry => entry.id as string));
	if (questions.some(record => (record.status === "open") !== openIds.has(record.id as string))) {
		throw new Error("hosted channel question records disagree with their drafts");
	}
	let threads = objects(item.threads, "comment thread");
	for (let thread of threads) {
		if (
			(thread.status !== "open" && thread.status !== "accepted" && thread.status !== "dismissed")
			|| !thread.passage
			|| typeof thread.passage !== "object"
			|| Array.isArray(thread.passage)
			|| !Array.isArray(thread.notes)
		) throw new Error("hosted channel has an invalid comment thread");
	}
	let transcript = objects(item.transcript, "transcript entry");
	for (let entry of transcript) {
		if (
			typeof entry.text !== "string"
			|| typeof entry.ts !== "number"
			|| !entry.author
			|| typeof entry.author !== "object"
			|| Array.isArray(entry.author)
		) throw new Error("hosted channel has an invalid transcript entry");
	}
	return {
		version: 1,
		revision: item.revision,
		documentSeq: item.documentSeq,
		questions: questions as never[],
		openQuestions,
		threads: threads as never[],
		transcript,
		...(typeof item.session === "string" ? { session: item.session } : {}),
	};
}

function digest(source: string): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function legacySink(plan: Plan, server: Server<SocketData>, id: string, dir: string): Sink {
	return snapshot.sink({
		dir,
		onFlush: () => {
			let before = signature(plan);
			Questions.rebase(plan);
			Comments.rebase(plan);
			if (signature(plan) !== before) anchors(plan, server, id);
		},
		read: () => ({ source: room.project(plan.document), state: state(plan) }),
		onWrite(status, message) {
			broadcast(server, id, {
				kind: "plan:status",
				ts: 0,
				state: status,
				revision: plan.revision,
				...(message ? { message } : {}),
			});
		},
	});
}

function hostedSink(plan: Plan): Sink {
	return {
		touch() {
			if (plan.durable?.closing) return;
			let captured = capture(plan);
			let commit = () => commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, captured);
			plan.flushing = plan.flushing.then(commit, commit);
		},
		async flush() {
			let durable = plan.durable;
			if (!durable) return;
			durable.closing = true;
			if (durable.checkpointTimer) clearTimeout(durable.checkpointTimer);
			durable.checkpointTimer = undefined;
			await plan.flushing;
			await commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, capture(plan));
			await checkpointHosted(plan);
		},
		cancel() {
			let durable = plan.durable;
			if (durable?.checkpointTimer) clearTimeout(durable.checkpointTimer);
			if (durable) {
				durable.checkpointTimer = undefined;
				durable.closing = true;
			}
		},
	};
}

function scheduleCheckpoint(plan: Plan): void {
	let durable = plan.durable;
	if (!durable || durable.closing || durable.checkpointTimer) return;
	durable.checkpointTimer = setTimeout(() => {
		durable.checkpointTimer = undefined;
		let checkpoint = () => checkpointHosted(plan);
		plan.flushing = plan.flushing.then(checkpoint, checkpoint);
	}, 500);
}

async function commitHosted(
	plan: Plan,
	update: Uint8Array | undefined,
	operationId: string,
	captured: Captured,
): Promise<void> {
	let durable = plan.durable;
	if (!durable) {
		plan.sink.touch();
		return;
	}
	if (!update && captured.sidecarText === durable.lastSidecar) {
		scheduleCheckpoint(plan);
		return;
	}
	try {
		let result = await durable.storage.collaboration.commit({
			channelId: durable.channelId,
			lease: durable.lease(),
			expectedRevision: durable.revision,
			operationId,
			epoch: captured.epoch,
			...(update ? { update } : {}),
			sidecar: captured.sidecar,
			events: [],
			now: new Date(),
		});
		if (!result.repeated) {
			durable.revision = result.revision;
			durable.sequence = result.sequence;
		}
		if (result.repeated && captured.sidecarText !== durable.lastSidecar) {
			let stateResult = await durable.storage.collaboration.commit({
				channelId: durable.channelId,
				lease: durable.lease(),
				expectedRevision: durable.revision,
				operationId: `state:${crypto.randomUUID()}`,
				epoch: captured.epoch,
				sidecar: captured.sidecar,
				events: [],
				now: new Date(),
			});
			durable.revision = stateResult.revision;
			durable.sequence = stateResult.sequence;
		}
		durable.lastSidecar = captured.sidecarText;
		durable.committedEpoch = captured.epoch;
		durable.committedSource = captured.source;
		durable.committedDocument = captured.document;
		durable.committedSidecar = captured.sidecar;
		if (plan.document.epoch === captured.epoch) {
			plan.document.checkpoint = new Uint8Array(captured.document);
		}
		scheduleCheckpoint(plan);
	} catch (err) {
		durable.fatal(err);
		throw err;
	}
}

async function checkpointHosted(plan: Plan): Promise<void> {
	let durable = plan.durable;
	if (!durable) return;
	try {
		await durable.storage.collaboration.checkpoint({
			channelId: durable.channelId,
			lease: durable.lease(),
			expectedRevision: durable.revision,
			generation: crypto.randomUUID(),
			revision: durable.revision,
			throughSequence: durable.sequence,
			epoch: durable.committedEpoch,
			source: durable.committedSource,
			sourceHash: digest(durable.committedSource),
			document: durable.committedDocument,
			sidecar: durable.committedSidecar,
			createdAt: new Date(),
		});
		plan.document.checkpoint = new Uint8Array(durable.committedDocument);
	} catch (err) {
		durable.fatal(err);
		throw err;
	}
}

async function replaceHosted(plan: Plan, operationId: string, captured: Captured): Promise<void> {
	let durable = plan.durable;
	if (!durable) return;
	try {
		let result = await durable.storage.collaboration.replace({
			channelId: durable.channelId,
			lease: durable.lease(),
			expectedRevision: durable.revision,
			operationId,
			generation: crypto.randomUUID(),
			epoch: captured.epoch,
			source: captured.source,
			sourceHash: digest(captured.source),
			document: captured.document,
			sidecar: captured.sidecar,
			now: new Date(),
		});
		if (!result.repeated) {
			durable.revision = result.revision;
			durable.sequence = result.sequence;
		}
		durable.lastSidecar = captured.sidecarText;
		durable.committedEpoch = captured.epoch;
		durable.committedSource = captured.source;
		durable.committedDocument = captured.document;
		durable.committedSidecar = captured.sidecar;
		plan.document.checkpoint = new Uint8Array(captured.document);
		if (durable.checkpointTimer) clearTimeout(durable.checkpointTimer);
		durable.checkpointTimer = undefined;
	} catch (err) {
		durable.fatal(err);
		throw err;
	}
}

/** Persist sidecar-only state, immediately in hosted mode and debounced on disk in legacy. */
export function persist(plan: Plan): Promise<void> {
	if (!plan.durable) {
		plan.sink.touch();
		return Promise.resolve();
	}
	let captured = capture(plan);
	let commit = () => commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, captured);
	let pending = plan.flushing.then(commit, commit);
	plan.flushing = pending;
	return pending;
}

/** Reserve the same queue used by client batches for one complete server operation. */
export function exclusive<T>(plan: Plan, action: () => Promise<T>): Promise<T> {
	let operation = plan.flushing.then(action, action);
	plan.flushing = operation.then(() => {}, () => {});
	return operation;
}

/** Sidecar-only commit for a caller already holding `exclusive`. */
export function persistExclusive(plan: Plan): Promise<void> {
	if (!plan.durable) {
		plan.sink.touch();
		return Promise.resolve();
	}
	return commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, capture(plan));
}

/**
 * Bring a room's plan into being.
 *
 * Restores from disk when there is something to restore, and validates it on
 * the way in: unlike a database record, this file is one a person can open and
 * edit between runs, so it is not trusted just because we wrote it.
 */
export async function open(
	id: string,
	backend: string | HostedBackend,
	server: Server<SocketData>,
): Promise<Plan> {
	let dir = typeof backend === "string" ? backend : undefined;
	let stored: snapshot.Stored | undefined;
	let document: Document;
	let durability: { backend: HostedBackend; revision: number; sequence: number } | undefined;
	let needsInitialCheckpoint = false;

	if (typeof backend === "string") {
		stored = await snapshot.load(backend);
		document = await room.create(stored?.source ?? "", true);
	} else {
		let loaded = await backend.storage.collaboration.load(id, new Date());
		if (!loaded) throw new Error(`hosted channel ${id} does not exist`);
		let pristine = loaded.channel.revision === 0
			&& loaded.latestSequence === 0
			&& !loaded.snapshot;
		let sidecar = restoredState(
			loaded.sidecar === null && loaded.snapshot && loaded.channel.revision === 0
				? loaded.snapshot.sidecar
				: loaded.sidecar,
			pristine,
		);
		if (loaded.snapshot) {
			if (
				loaded.snapshot.revision > loaded.channel.revision
				|| loaded.snapshot.throughSequence > loaded.latestSequence
			) throw new Error(`hosted channel ${id} has an invalid checkpoint position`);
			let previous = loaded.snapshot.throughSequence;
			for (let update of loaded.updates) {
				if (
					update.sequence <= previous
					|| update.sequence > loaded.latestSequence
					|| update.revision > loaded.channel.revision
					|| update.epoch !== loaded.snapshot.epoch
				) throw new Error(`hosted channel ${id} has an invalid update journal`);
				previous = update.sequence;
			}
			if (digest(loaded.snapshot.source) !== loaded.snapshot.sourceHash) {
				throw new Error(`hosted channel ${id} has a corrupt source hash`);
			}
			document = await room.restore(
				loaded.snapshot.epoch,
				loaded.snapshot.document,
				loaded.snapshot.source,
				loaded.updates.map(update => ({ epoch: update.epoch, update: update.update })),
			);
		} else {
			if (loaded.updates.length > 0) {
				throw new Error(`hosted channel ${id} has updates without a checkpoint`);
			}
			document = await room.create();
			needsInitialCheckpoint = true;
		}
		document.seq = sidecar.documentSeq ?? 0;
		stored = { source: room.project(document), state: sidecar };
		durability = {
			backend,
			revision: loaded.channel.revision,
			sequence: loaded.latestSequence,
		};
	}

	if (stored?.source) {
		try {
			room.validate(stored.source);
		} catch (err) {
			let message = err instanceof Error ? err.message : String(err);
			throw new Error(`${dir ?? `channel ${id}`} is not a valid plan: ${message}`, { cause: err });
		}
	}

	let plan: Plan = {
		id,
		server,
		document,
		presence: presence.create(),
		questions: stored?.state.openQuestions
			? Questions.restore(stored.state.openQuestions as Questions.StoredOpen[])
			: Questions.create(),
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
		sink: undefined as unknown as Sink,
	};

	if (dir) plan.sink = legacySink(plan, server, id, dir);
	else if (durability) {
		let committed = capture(plan);
		plan.durable = {
			...durability.backend,
			channelId: id,
			revision: durability.revision,
			sequence: durability.sequence,
			lastSidecar: committed.sidecarText,
			checkpointTimer: undefined,
			committedEpoch: committed.epoch,
			committedSource: committed.source,
			committedDocument: committed.document,
			committedSidecar: committed.sidecar,
			closing: false,
		};
		plan.sink = hostedSink(plan);
		if (needsInitialCheckpoint) await checkpointHosted(plan);
	}

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
		if (plan.durable) {
			await replaceHosted(plan, `epoch:${rebuilt.epoch}`, capture(plan));
		}

		broadcast(plan.server, plan.id, {
			kind: "plan:reset",
			ts: 0,
			epoch: rebuilt.epoch,
			reason: "rebuilt",
		});
		return;
	}

	let relationshipsChanged = false;
	if (plan.durable) {
		let before = signature(plan);
		try {
			Questions.rebase(plan);
			Comments.rebase(plan);
			relationshipsChanged = signature(plan) !== before;
		} catch (err) {
			console.error("[plan] could not carry hosted anchors forward:", err);
		}
	}
	plan.revision++;
	if (plan.durable) {
		let merged = Y.mergeUpdates(batch.map(item => item.update));
		let operationId = `plan:${plan.document.epoch}:${
			createHash("sha256").update(merged).digest("hex")
		}`;
		await commitHosted(plan, merged, operationId, capture(plan));
	}

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

	if (!plan.durable) room.mark(plan.document);
	if (relationshipsChanged) anchors(plan, plan.server, plan.id);
	if (!plan.durable) plan.sink.touch();
}

/**
 * Relay a change the server made, as an ordinary update.
 *
 * Agent edits and answer projections reach clients the same way a keystroke
 * does: as a delta against the document they already hold. That is what keeps
 * an agent rewriting a paragraph from costing everybody else their cursor.
 */
export async function publish(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	mutation: { update: Uint8Array; source: string },
): Promise<void> {
	plan.document.seq++;
	plan.revision++;
	if (plan.durable) {
		let operationId = `server:${plan.document.epoch}:${
			createHash("sha256").update(mutation.update).digest("hex")
		}`;
		await commitHosted(plan, mutation.update, operationId, capture(plan));
	}
	try {
		broadcast(server, roomId, {
			kind: "plan:update",
			ts: 0,
			epoch: plan.document.epoch,
			update: encode(mutation.update),
			seq: plan.document.seq,
		});
	} catch (err) {
		console.error("[plan] could not broadcast a persisted update:", err);
	}
	if (!plan.durable) room.mark(plan.document);
	if (!plan.durable) plan.sink.touch();
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
		// The furthest down the plan this batch reached, of what could be
		// anchored — where the agent leaves its cursor.
		let last: number | undefined;

		for (let change of found) {
			if (change.kind === "removed") {
				let at = gap(change.at);
				if (at) {
					wired.push({ kind: "removed", at, blocks: change.blocks });
					last = change.at.index;
				}
				continue;
			}

			let at = anchor(change.index);
			if (!at) continue;
			if (change.kind === "added") {
				wired.push({ kind: "added", at, type: change.type, preview: change.preview });
				last = change.index;
				continue;
			}

			// Both ends or neither: a move shown only where it landed reads as
			// new prose, and shown only where it left reads as a deletion.
			let from = gap(change.from);
			if (from) {
				wired.push({ kind: "moved", at, from, type: change.type, preview: change.preview });
				last = change.index;
			}
		}

		if (wired.length === 0) return;
		broadcast(server, roomId, {
			kind: "plan:changes",
			ts: 0,
			epoch: plan.document.epoch,
			changes: wired,
		});

		// Read off the same pass, deliberately. Working it out separately could
		// disagree, and then the cursor would point at one block while the
		// marks described another.
		if (last !== undefined) attend(plan, server, roomId, last);
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
	block: number,
): void {
	// The last turn may still be counting down to taking the cursor away. It is
	// about to be somewhere new, so that removal is no longer the truth.
	clearTimeout(plan.chat.lingering);
	plan.chat.lingering = undefined;

	let position = room.endOf(plan.document, block);
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
