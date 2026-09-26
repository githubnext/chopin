/**
 * Chat.
 *
 * One transcript per room, shared by everyone in it, and one turn at a time.
 * Messages that address the agent are queued rather than refused while it is
 * working: the plan belongs to the agent for the length of a turn, but the
 * Chat does not, and silencing somebody because a colleague prompted
 * first is a poor way to run a room with two people in it.
 *
 * Messages that do not address it are ordinary conversation. They are carried
 * into the next turn as context rather than starting one, so people can decide
 * something between themselves and the agent turns up already knowing.
 *
 * Every message reaching the model is prefixed with its author's handle. The
 * agent is planning with a group, and "Alice prefers X, but Bob raised Y" is
 * the kind of thing it has to be able to say back.
 */

import { createHash } from "node:crypto";

import { ulid } from "@chopin/dialect";

import { PLANNER_TOOL_NAMES } from "../harness/tool-names";
import type { PlannerSession } from "../harness/session";
import { plannerInstructions } from "../agent/planner";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { DocumentRoom, ResearchWorkspaceRequest } from "../agent/tools";
import * as Service from "../plan/service";
import { instruction } from "@chopin/protocol/address";

import { annotatedText, compose, referenceCatalog, remember } from "./address";
import { broadcast, fail, reply, tell } from "../wire";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { HostedAuth } from "../auth/routes";
import type { HostedRepository } from "../agent/repository";
import type { JobService } from "../jobs/service";
import type { Plan } from "../plan/service";
import type { Said } from "./address";
import type { ReferenceService } from "./references";
import type { Socket, SocketData } from "../wire";

/** Beyond this the queue is a backlog nobody is going to read. */
const MAX_QUEUE = 20;
const MAX_PENDING_SENDS = 20;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SESSION_REFERENCES = 50;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

type Delivery = {
	destination: Wire.Destination;
	requestFingerprint: string;
	canonicalFingerprint: string;
};

type MemberEntry = Wire.Entry & { delivery?: Delivery };

/** How long the agent's cursor stays where it finished, after a turn ends. */
const LINGER_MS = 5_000;
const ACTIVE_TOOLS = new Set(PLANNER_TOOL_NAMES);

/**
 * A queued message, with what the queue needs and clients do not.
 *
 * `spent` is asked, just before the turn would run, whether somebody else has
 * already done the work. It is a function rather than a flag because the answer
 * is only knowable at that moment — and `JSON.stringify` drops it, so the wire
 * shape stays exactly `Wire.Waiting`.
 */
type Waiting = Wire.Waiting & {
	delivery?: Delivery;
	spent?: () => boolean;
	/** True when this came from the composer rather than another instruction. */
	message?: boolean;
	/** The comment thread this turn was started to act on, if one was. */
	thread?: string;
	/** Login session whose Copilot entitlement owns this queued turn. */
	sessionId?: string;
	/** Verified member identity, retained only for a queued composer message. */
	userId?: string;
};

export type ActiveMemberRequest = {
	entryId: string;
	userId: string;
	handle: string;
	text: string;
	claimantSessionId: string;
	turnId: string;
	lifecycle: number;
};

type MemberRequest = Pick<ActiveMemberRequest, "entryId" | "userId">;

/** What a turn other than a message needs to say about itself. */
export type Instruction = {
	spent?: () => boolean;
	thread?: string;
};

export type Chat = {
	entries: Wire.Entry[];
	waiting: Waiting[];
	/** Serializes complete member send acceptance, including asynchronous resolution and persistence. */
	sending: Promise<void>;
	/** Work admitted to the send FIFO, including the operation currently resolving. */
	pendingSends: number;
	/** Per-turn owner for revocation and credential rotation fencing. */
	openingOwner?: { sessionId: string; generation: number; revision: number };
	/** Current disposable session; never reused by the next turn. */
	agent?: PlannerSession;
	turnController?: AbortController;
	/** Fences a turn invalidated while opening or streaming. */
	lifecycle: number;
	running?: Promise<void>;
	closed: boolean;
	busy: boolean;
	/** The transient lifecycle of the running Planner turn. */
	turn?: Wire.Turn;
	/** Private provenance for the member message driving only the current turn. */
	activeRequest?: ActiveMemberRequest;
	/**
	 * The comment thread the running turn is acting on.
	 *
	 * Read by `edit_plan`, so the prose a turn writes can be recorded as what
	 * that decision produced even when the agent forgets to say so itself.
	 */
	acting?: string;
	/** The entry the agent is currently writing into. */
	writing?: string;
	/** The dedicated entry collecting tool calls for this turn. */
	tooling?: string;
	/** Pending removal of the agent's cursor, cancelled if it edits again. */
	lingering?: ReturnType<typeof setTimeout>;
	/** When each running tool call started, for its duration. */
	timings: Map<string, number>;
	/** Text part ids are adapter-local; transcript ids are unique across turns. */
	messageIds?: Map<string, string>;
	/** Owner identity for the running turn only. */
	owner?: { sessionId: string; generation: number; revision: number };
	/** User-facing reason an in-flight turn was interrupted. */
	interruption?: string;
	/** Backscroll entries already represented by an opening session's bootstrap. */
	bootstrapEntries?: Set<string>;
	/** References available to `read_reference` in the active SDK session. */
	referenceCache: Map<string, Wire.Reference>;
	/**
	 * What the room has said since the agent last ran.
	 *
	 * Deliberately not persisted: a conversation the agent never saw has no
	 * claim on surviving a restart, and replaying it later would be stranger
	 * than losing it.
	 */
	backscroll: Said[];
};

export function create(): Chat {
	return {
		entries: [],
		waiting: [],
		sending: Promise.resolve(),
		pendingSends: 0,
		busy: false,
		lifecycle: 0,
		closed: false,
		timings: new Map(),
		referenceCache: new Map(),
		backscroll: [],
	};
}

/**
 * Come back with what was said before.
 *
 * An entry that was still streaming when the process went away never finished,
 * so the flag is cleared: it is as complete as it is ever going to be, and
 * leaving it set would show a spinner nothing will ever stop.
 */
export function restore(entries: Wire.Entry[]): Chat {
	return {
		entries: entries.map(entry => {
			let { streaming: _streaming, ...rest } = entry;
			return rest;
		}),
		waiting: [],
		sending: Promise.resolve(),
		pendingSends: 0,
		busy: false,
		lifecycle: 0,
		closed: false,
		timings: new Map(),
		referenceCache: new Map(),
		backscroll: [],
	};
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requestFingerprint(msg: Request<Wire.Send>, principalId: string): string {
	let references = Array.isArray(msg.references)
		? msg.references.map(value => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			let item = value as unknown as Record<string, unknown>;
			return Object.keys(item).sort().map(key => [key, item[key]]);
		})
		: msg.references ?? [];
	return digest(JSON.stringify([principalId, msg.to, msg.text, references]));
}

function canonicalFingerprint(
	destination: Wire.Destination,
	text: string,
	references: Wire.Reference[] = [],
): string {
	let targets = references.map(reference =>
		reference.kind === "document"
			? [
				reference.kind,
				reference.id,
				reference.start,
				reference.end,
				reference.label,
				reference.href,
				reference.repositoryId,
				reference.observedRevision,
				reference.channelId,
				reference.observedSourceHash,
			]
			: [
				reference.kind,
				reference.id,
				reference.start,
				reference.end,
				reference.label,
				reference.href,
				reference.repositoryId,
				reference.observedRevision,
				reference.parentChannelId,
				reference.workspaceId,
			]
	);
	return digest(JSON.stringify([destination, text, targets]));
}

function delivery(
	destination: Wire.Destination,
	request: string,
	text: string,
	references: Wire.Reference[] = [],
): Delivery {
	return {
		destination,
		requestFingerprint: request,
		canonicalFingerprint: canonicalFingerprint(destination, text, references),
	};
}

function publicEntry(value: Wire.Entry): Wire.Entry {
	let { delivery: _delivery, ...entry } = value as MemberEntry;
	return entry;
}

export function validateDelivery(entry: Wire.Entry): void {
	let saved = (entry as MemberEntry).delivery;
	if (saved === undefined) return;
	let keys = saved && typeof saved === "object" && !Array.isArray(saved)
		? Object.keys(saved).sort()
		: [];
	if (
		entry.author.kind !== "member" || !REQUEST_ID.test(entry.id)
		|| keys.length !== 3
		|| keys[0] !== "canonicalFingerprint"
		|| keys[1] !== "destination"
		|| keys[2] !== "requestFingerprint"
		|| (saved.destination !== "room" && saved.destination !== "planner")
		|| typeof saved.requestFingerprint !== "string" || !FINGERPRINT.test(saved.requestFingerprint)
		|| typeof saved.canonicalFingerprint !== "string"
		|| !FINGERPRINT.test(saved.canonicalFingerprint)
		|| saved.canonicalFingerprint
			!== canonicalFingerprint(saved.destination, entry.text, entry.references)
	) throw new Error("hosted channel has invalid chat delivery metadata");
}

function replay(
	chat: Chat,
	ws: Socket,
	msg: Request<Wire.Send>,
	requestId: string,
	fingerprint: string,
): boolean {
	let entries = chat.entries.filter(entry => entry.id === requestId);
	let waiting = chat.waiting.filter(item => item.id === requestId);
	if (entries.length === 0 && waiting.length === 0) return false;
	if (entries.length + waiting.length !== 1) {
		fail(ws, msg.rid, "chat request id conflicts with existing state");
		return true;
	}
	let entry = entries[0];
	let queued = waiting[0];
	let saved = entry ? (entry as MemberEntry).delivery : queued?.delivery;
	try {
		if (entry) validateDelivery(entry);
		else if (
			!queued || !saved || !REQUEST_ID.test(queued.id)
			|| saved.canonicalFingerprint
				!== canonicalFingerprint(saved.destination, queued.text, queued.references)
		) throw new Error("invalid queued delivery metadata");
	} catch {
		fail(ws, msg.rid, "chat request id conflicts with existing state");
		return true;
	}
	if (!saved || saved.destination !== msg.to || saved.requestFingerprint !== fingerprint) {
		fail(ws, msg.rid, "chat request id was reused with different content");
		return true;
	}
	reply(ws, msg.rid, {
		kind: "chat:send",
		ts: 0,
		id: (entry ?? queued)!.id,
		queued: waiting.length === 1,
	});
	return true;
}

function state(chat: Chat, server: Server<SocketData>, room: string): void {
	broadcast(server, room, {
		kind: "chat:state",
		ts: 0,
		busy: chat.busy,
		...(chat.turn ? { turn: chat.turn } : {}),
	});
}

/** Only visible Planner prose ends the working projection. */
function responded(chat: Chat, server: Server<SocketData>, room: string, text: string): void {
	if (!chat.turn || chat.turn.responded || !text.trim()) return;
	chat.turn.responded = true;
	state(chat, server, room);
}

/**
 * The queue as clients see it.
 *
 * Internal queue metadata decides how and under whose authority a turn runs.
 * None of it belongs in the wire projection.
 */
function visible(chat: Chat): Wire.Waiting[] {
	return chat.waiting.map(({ handle, id, text, references }) => ({
		handle,
		id,
		text,
		...(references?.length ? { references } : {}),
	}));
}

function queued(chat: Chat, server: Server<SocketData>, room: string): void {
	broadcast(server, room, { kind: "chat:queue", ts: 0, waiting: visible(chat) });
}

function say(
	chat: Chat,
	server: Server<SocketData>,
	room: string,
	entry: Wire.Entry,
): Wire.Entry {
	chat.entries.push(entry);
	announce(server, room, entry);
	return entry;
}

function announce(server: Server<SocketData>, room: string, entry: Wire.Entry): void {
	broadcast(server, room, { kind: "chat:message", ts: 0, entry: publicEntry(entry) });
}

/** Everything said so far, for somebody who has just arrived. */
export function greet(chat: Chat, ws: Socket): void {
	tell(ws, {
		kind: "chat:history",
		ts: 0,
		entries: chat.entries.map(publicEntry),
		busy: chat.busy,
		...(chat.turn ? { turn: chat.turn } : {}),
		queued: visible(chat),
	});
}

export type Room = {
	chat: Chat;
	plan: Plan;
	server: Server<SocketData>;
	room: string;
	config: Config;
	auth: HostedAuth;
	claimantSessionId: string;
	repository: HostedRepository;
	activeOwner?: () => Promise<ActiveOwnerBinding | undefined>;
	persist: () => Promise<void>;
	openPlannerSession?: typeof import("../harness/session")["openPlannerSession"];
	ownerAvailable?: () => Promise<void>;
	jobs?: JobService;
	references?: ReferenceService;
	createResearch?: (request: {
		entryId: string;
		userId: string;
		handle: string;
		text: string;
		question: string;
	}) => Promise<ResearchWorkspaceRequest>;
};

/**
 * Take a message.
 *
 * A room message appears immediately. A planner message queued behind another
 * turn stays visibly queued until that turn actually begins, then moves into
 * the transcript exactly once. The destination, rather than its prose, decides
 * which lifecycle it takes.
 */
export function send(context: Room, ws: Socket, msg: Request<Wire.Send>): Promise<void> {
	if (context.chat.pendingSends >= MAX_PENDING_SENDS) {
		fail(ws, msg.rid, "too many chat messages are waiting to be processed");
		return Promise.resolve();
	}
	context.chat.pendingSends++;
	let process = () => processSend(context, ws, msg);
	let accepted = context.chat.sending.then(process, process);
	let completed = accepted.finally(() => context.chat.pendingSends--);
	context.chat.sending = completed.then(() => {}, () => {});
	return completed;
}

async function processSend(context: Room, ws: Socket, msg: Request<Wire.Send>): Promise<void> {
	let { chat, room, server } = context;
	let suppliedRequestId = (msg as Request<Wire.Send> & { requestId?: unknown }).requestId;
	if (
		suppliedRequestId !== undefined && (
			typeof suppliedRequestId !== "string" || !REQUEST_ID.test(suppliedRequestId)
		)
	) {
		return fail(ws, msg.rid, "chat request id must be a UUIDv4");
	}
	// Pre-deploy browser tabs did not send request IDs. They keep legacy at-most-once behavior.
	let requestId = suppliedRequestId ?? crypto.randomUUID();
	let handle = ws.data.handle;
	let destination = msg.to;
	if (destination !== "room" && destination !== "planner") {
		return fail(ws, msg.rid, "invalid message destination");
	}
	if (typeof msg.text !== "string") return fail(ws, msg.rid, "invalid message text");
	if (Buffer.byteLength(msg.text) > MAX_MESSAGE_BYTES) {
		return fail(ws, msg.rid, "chat message exceeds the 64 KiB limit");
	}
	let request = requestFingerprint(msg, ws.data.principalId);
	if (replay(chat, ws, msg, requestId, request)) return;
	if (chat.closed) return fail(ws, msg.rid, "chat is closed");
	let projected: { text: string; references?: Wire.Reference[] };
	try {
		if (context.references) {
			projected = await context.references.resolve({
				channelId: room,
				repositoryId: context.repository.id,
				text: msg.text,
				destination,
				requests: msg.references,
			});
		} else {
			if (
				msg.references !== undefined && (!Array.isArray(msg.references) || msg.references.length)
			) {
				return fail(ws, msg.rid, "chat references are unavailable");
			}
			let text = msg.text.trim();
			projected = { text: destination === "planner" ? instruction(text) : text };
		}
	} catch {
		return fail(ws, msg.rid, "invalid or unavailable chat reference");
	}
	let text = projected.text;
	let references = projected.references;
	if (!text) return fail(ws, msg.rid, "message text is empty");
	if (chat.closed) return fail(ws, msg.rid, "chat is closed");
	let savedDelivery = delivery(destination, request, text, references);

	if (destination === "room") {
		let entry: MemberEntry = {
			id: requestId,
			author: { kind: "member", handle },
			text,
			ts: now(),
			...(references?.length ? { references } : {}),
			delivery: savedDelivery,
		};
		chat.entries.push(entry);
		try {
			await context.persist();
		} catch {
			chat.entries = chat.entries.filter(value => value.id !== entry.id);
			return fail(ws, msg.rid, "could not save message");
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id, queued: false });
		announce(server, room, entry);
		chat.backscroll = remember(chat.backscroll, {
			entryId: entry.id,
			handle,
			text,
			...(references?.length ? { references } : {}),
		});
		return;
	}
	if (!context.config.agent) {
		let entries: MemberEntry[] = [{
			id: requestId,
			author: { kind: "member", handle },
			text,
			ts: now(),
			...(references?.length ? { references } : {}),
			delivery: savedDelivery,
		}, {
			id: ulid(),
			author: { kind: "system" },
			text: "The agent is not running, so the plan has not been revised.",
			ts: now(),
		}];
		chat.entries.push(...entries);
		try {
			await context.persist();
		} catch {
			let ids = new Set(entries.map(entry => entry.id));
			chat.entries = chat.entries.filter(entry => !ids.has(entry.id));
			return fail(ws, msg.rid, "could not save message");
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entries[0]!.id, queued: false });
		for (let entry of entries) announce(server, room, entry);
		return;
	}

	if (chat.busy) {
		if (chat.waiting.length >= MAX_QUEUE) {
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: "The queue is full. Wait for the current turn to finish.",
				ts: now(),
			});
			return fail(ws, msg.rid, "the Planner queue is full");
		}
		let waiting: Waiting = {
			id: requestId,
			handle,
			text,
			...(references?.length ? { references } : {}),
			delivery: savedDelivery,
			message: true,
			sessionId: context.claimantSessionId,
			userId: ws.data.principalId,
		};
		chat.waiting.push(waiting);
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: waiting.id, queued: true });
		return queued(chat, server, room);
	}

	let entry: MemberEntry = {
		id: requestId,
		author: { kind: "member", handle },
		text,
		ts: now(),
		...(references?.length ? { references } : {}),
		delivery: savedDelivery,
	};
	chat.busy = true;
	chat.turn = { id: ulid(), handle, started: now(), responded: false };
	state(chat, server, room);
	chat.entries.push(entry);
	try {
		await context.persist();
	} catch {
		chat.entries = chat.entries.filter(value => value.id !== entry.id);
		chat.busy = false;
		chat.turn = undefined;
		state(chat, server, room);
		return fail(ws, msg.rid, "could not save message");
	}
	reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id, queued: false });
	if (chat.closed) return;
	announce(server, room, entry);
	startRun(
		context,
		handle,
		text,
		undefined,
		context.claimantSessionId,
		true,
		{ entryId: entry.id, userId: ws.data.principalId },
		references,
	);
}

/** Say something in the transcript without asking the agent for anything. */
export function notice(context: Room, text: string): void | Promise<void> {
	let { chat, room, server } = context;
	let entry: Wire.Entry = { id: ulid(), author: { kind: "system" }, text, ts: now() };
	chat.entries.push(entry);
	return context.persist().then(() => announce(server, room, entry));
}

/**
 * Start a turn from something other than a message.
 *
 * Accepting a comment is an instruction in a way prose is not — the `@chopin` rule
 * exists to separate conversation from instruction, and a button press is
 * already the latter. What it is not is a thing anybody said, so the transcript
 * gets a system entry explaining why the agent started moving; an agent that
 * begins editing for no visible reason is worse than a noisy log.
 */
export function instruct(
	context: Room,
	handle: string,
	text: string,
	said: string,
	about: Instruction = {},
): void | Promise<void> {
	let { chat, config, room, server } = context;
	let proceed = (): void | Promise<void> => {
		if (chat.closed) return;
		// `AGENT=off` runs the room without one. The decision that got here is
		// still a decision and is already recorded; only the turn is impossible,
		// and saying so beats a session failing to open.
		if (!config.agent) {
			let entry: Wire.Entry = {
				id: ulid(),
				author: { kind: "system" },
				text: "The agent is not running, so the plan has not been revised.",
				ts: now(),
			};
			chat.entries.push(entry);
			return context.persist().then(() => announce(server, room, entry));
		}

		if (chat.busy) {
			if (chat.waiting.length >= MAX_QUEUE) {
				return void say(chat, server, room, {
					id: ulid(),
					author: { kind: "system" },
					text: "The queue is full. Wait for the current turn to finish.",
					ts: now(),
				});
			}
			chat.waiting.push({
				id: ulid(),
				handle,
				text,
				...about,
				sessionId: context.claimantSessionId,
			});
			return queued(chat, server, room);
		}

		startRun(context, handle, text, about.thread, context.claimantSessionId);
	};
	let announced = notice(context, said);
	return announced instanceof Promise ? announced.then(proceed) : proceed();
}

/** Withdraw a queued message. Only whoever wrote it may. */
export function unqueue(context: Room, ws: Socket, msg: Request<Wire.Unqueue>): void {
	let { chat, room, server } = context;
	let found = chat.waiting.find(item => item.id === msg.id);
	if (!found || found.handle !== ws.data.handle) return;
	chat.waiting = chat.waiting.filter(item => item.id !== msg.id);
	queued(chat, server, room);
}

/** Stop the running turn. Anyone may, and the transcript says who did. */
export async function abort(context: Room, ws: Socket): Promise<void> {
	let { chat, room, server } = context;
	if (!chat.busy || !chat.turnController) return;
	chat.turnController.abort();
	say(chat, server, room, {
		id: ulid(),
		author: { kind: "system" },
		text: `@${ws.data.handle} stopped the turn.`,
		ts: now(),
	});
}

function currentMemberRequest(chat: Chat): ActiveMemberRequest | undefined {
	let active = chat.activeRequest;
	if (
		!active || chat.closed || !chat.busy || chat.lifecycle !== active.lifecycle
		|| chat.turn?.id !== active.turnId || !active.userId || !active.claimantSessionId
	) return undefined;
	let entry = chat.entries.find(value => value.id === active.entryId);
	if (
		entry?.author.kind !== "member" || entry.author.handle !== active.handle
		|| entry.text !== active.text
	) return undefined;
	return active;
}

export function documentRoom(context: Room): DocumentRoom {
	let { chat, plan, room, server } = context;
	return {
		id: room,
		plan,
		server,
		publish: mutation => Service.publish(plan, server, room, mutation),
		persist: context.persist,
		exclusive: action => Service.exclusive(plan, action),
		anchors: () => Service.anchors(plan, server, room),
		changes: found => Service.changes(plan, server, room, found),
		jobs: context.jobs,
		readReference: async (id, repositoryId) => {
			let reference = chat.referenceCache.get(id);
			if (!reference) throw new Error("reference is not available in this Planner session");
			if (!context.references) throw new Error("chat references are unavailable");
			return context.references.read({
				channelId: room,
				repositoryId,
				reference,
			});
		},
		createResearch: async _question => {
			let active = currentMemberRequest(chat);
			if (!active) {
				throw new Error(
					"research workspaces require the explicit member message driving the current turn",
				);
			}
			let createResearch = context.createResearch;
			if (!createResearch) throw new Error("research workspaces are unavailable");
			return createResearch({
				entryId: active.entryId,
				userId: active.userId,
				handle: active.handle,
				text: active.text,
				question: active.text,
			});
		},
	};
}

export function retainReferences(chat: Chat, references: Wire.Reference[]): void {
	for (let reference of references) {
		chat.referenceCache.delete(reference.id);
		chat.referenceCache.set(reference.id, reference);
		while (chat.referenceCache.size > MAX_SESSION_REFERENCES) {
			let oldest = chat.referenceCache.keys().next().value;
			if (typeof oldest !== "string") break;
			chat.referenceCache.delete(oldest);
		}
	}
}

export function sessionBootstrap(
	chat: Chat,
	cursor: number,
	summary: string,
	currentEntryId?: string,
	currentReferences: Wire.Reference[] = [],
): string | undefined {
	let start = Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= chat.entries.length
		? cursor
		: 0;
	let candidates = chat.entries.slice(start)
		.filter(entry => entry.id !== currentEntryId)
		.slice(-100);
	let allReferenceIds = new Set(
		candidates.flatMap(entry => entry.references?.map(reference => reference.id) ?? []),
	);
	let line = (entry: Wire.Entry, readable: Set<string>) => {
		let speaker = entry.author.kind === "member"
			? `@${entry.author.handle}`
			: entry.author.kind === "agent"
			? "Planner"
			: "System";
		return `${speaker}: ${annotatedText(entry.text, entry.references, readable)}`;
	};
	let selected: Wire.Entry[] = [];
	let used = 0;
	let partial = false;
	for (let entry of candidates.toReversed()) {
		let rendered = line(entry, allReferenceIds);
		let separator = selected.length > 0 ? 1 : 0;
		if (used + separator + rendered.length > 50_000) {
			if (selected.length === 0) {
				selected.unshift(entry);
				partial = true;
			}
			break;
		}
		selected.unshift(entry);
		used += separator + rendered.length;
	}
	let selectedIds = new Set(selected.map(entry => entry.id));
	let remainingBackscroll = chat.backscroll.filter(said =>
		!said.entryId || !selectedIds.has(said.entryId)
	);
	chat.referenceCache.clear();
	retainReferences(chat, selected.flatMap(entry => entry.references ?? []));
	retainReferences(chat, [
		...remainingBackscroll.flatMap(said => said.references ?? []),
		...currentReferences,
	]);
	let readable = new Set(chat.referenceCache.keys());
	let lines = selected.map(entry => line(entry, readable));
	if (partial && lines[0]) lines[0] = lines[0].slice(-50_000);
	chat.bootstrapEntries = new Set(selected.map(entry => entry.id));
	let transcript = lines.join("\n");
	if (!transcript && !summary) return undefined;
	let durableIds = new Set(
		selected.flatMap(entry => entry.references?.map(reference => reference.id) ?? []),
	);
	let catalog = referenceCatalog(
		[...chat.referenceCache.values()].filter(reference => durableIds.has(reference.id)),
	);
	return [
		"A fresh Planner session starts for each turn.",
		summary ? `Earlier durable summary:\n${summary}` : "",
		transcript ? `Durable conversation context follows:\n${transcript}` : "",
		catalog ?? "",
	].filter(Boolean).join("\n\n");
}

export function consumeBootstrapBackscroll(chat: Chat): void {
	let entries = chat.bootstrapEntries;
	chat.bootstrapEntries = undefined;
	if (!entries?.size) return;
	chat.backscroll = chat.backscroll.filter(said => !said.entryId || !entries.has(said.entryId));
}

async function repositorySession(
	context: Room,
	claimantSessionId: string,
	currentEntryId?: string,
	currentReferences: Wire.Reference[] = [],
): Promise<{ session: PlannerSession; binding: ActiveOwnerBinding }> {
	let { ownership, owner, repository } = await resolveOwner(
		context.auth,
		context.repository,
		context.room,
		claimantSessionId,
	);
	if (context.ownerAvailable) void context.ownerAvailable().catch(() => {});
	let { chat, auth } = context;
	let lifecycle = chat.lifecycle;
	let ownerSessionId = ownership.ownerSessionId!;
	let openingOwner = {
		sessionId: ownerSessionId,
		generation: ownership.generation,
		revision: owner.access.revision,
	};
	chat.openingOwner = openingOwner;
	let binding: ActiveOwnerBinding | undefined;
	let opened: PlannerSession | undefined;
	try {
		binding = await context.activeOwner?.();
		if (
			!binding || binding.ownerSessionId !== ownerSessionId
			|| binding.ownerGeneration !== ownership.generation
			|| binding.credentialRevision !== owner.access.revision
			|| binding.repository.id !== repository.id
			|| chat.lifecycle !== lifecycle || chat.openingOwner !== openingOwner
		) throw new Error("The Planner owner changed while opening. Try again.");
		await auth.storage.channels.updateAgentContext({
			channelId: context.room,
			ownerSessionId,
			generation: ownership.generation,
			summary: ownership.summary,
			transcriptCursor: ownership.transcriptCursor,
			status: "ready",
			now: new Date(),
		});
		chat.referenceCache.clear();
		let bootstrap = sessionBootstrap(
			chat,
			ownership.transcriptCursor,
			ownership.summary,
			currentEntryId,
			currentReferences,
		);
		let open = context.openPlannerSession
			?? (await import("../harness/session")).openPlannerSession;
		let result = await open(binding, {
			room: documentRoom(context),
			repository,
			instructions: plannerInstructions(
				`${repository.owner}/${repository.name}`,
				bootstrap,
			),
			model: context.config.model,
		});
		if (!result.ok) throw new Error(`Planner session unavailable (${result.error.kind})`);
		opened = result.value;
		if (
			chat.lifecycle !== lifecycle || chat.openingOwner !== openingOwner
			|| binding.signal.aborted || !await binding.revalidate()
		) throw new Error("The Planner session changed while opening. Try again.");
		chat.agent = opened;
		chat.owner = openingOwner;
		consumeBootstrapBackscroll(chat);
		return { session: opened, binding };
	} catch (err) {
		await opened?.destroy();
		binding?.release();
		chat.bootstrapEntries = undefined;
		await auth.storage.channels.updateAgentContext({
			channelId: context.room,
			ownerSessionId,
			generation: ownership.generation,
			summary: ownership.summary,
			transcriptCursor: ownership.transcriptCursor,
			status: "unavailable",
			now: new Date(),
		}).catch(() => {});
		throw err;
	} finally {
		if (chat.openingOwner === openingOwner) chat.openingOwner = undefined;
	}
}

export async function resolveOwner(
	auth: HostedAuth,
	repository: HostedRepository,
	channelId: string,
	claimantSessionId: string,
) {
	let ownership = await auth.storage.channels.claimAgentOwner(
		channelId,
		claimantSessionId,
		new Date(),
	);
	let ownerSessionId = ownership.ownerSessionId;
	if (!ownerSessionId) throw new Error("This channel's Copilot owner is unavailable.");
	let owner = await auth.sessions.resolve(ownerSessionId);
	if (!owner) {
		throw new Error("The Copilot owner must sign in again or reset this channel's agent.");
	}
	let checked = await auth.sessions.use(
		owner,
		token => auth.github.repositoryAccess(token, repository.owner, repository.name),
	);
	owner = checked.authenticated;
	let current = checked.value;
	if (
		!current
		|| current.id !== repository.id
		|| (!current.permissions.push && !current.permissions.admin)
	) throw new Error("The Copilot owner no longer has repository write access.");
	return { ownership, owner, repository };
}

/**
 * Finish anything left mid-sentence.
 *
 * A message is normally completed by `assistant.message`, which arrives at the
 * end of a stream. An aborted or failed turn never sends one, so without this
 * the entry keeps its streaming flag and every client goes on drawing a caret
 * after a message that will never be added to.
 */
function settle(chat: Chat, server: Server<SocketData>, room: string): void {
	for (let entry of chat.entries) {
		if (!entry.streaming) continue;
		delete entry.streaming;
		announce(server, room, entry);
	}
}

/** Run one turn, then drain whatever queued up behind it. */
async function run(
	context: Room,
	handle: string,
	text: string,
	thread: string | undefined,
	claimantSessionId: string,
	reserved = false,
	member?: MemberRequest,
	references: Wire.Reference[] = [],
): Promise<void> {
	let { chat, plan, room, server } = context;
	if (chat.closed) return;

	if (!reserved) {
		chat.busy = true;
		chat.turn = { id: ulid(), handle, started: now(), responded: false };
		chat.acting = thread;
		state(chat, server, room);
	} else chat.acting = thread;

	chat.activeRequest = member && chat.turn
		? {
			entryId: member.entryId,
			userId: member.userId,
			handle,
			text,
			claimantSessionId,
			turnId: chat.turn.id,
			lifecycle: chat.lifecycle,
		}
		: undefined;
	chat.messageIds = new Map();

	let opened: { session: PlannerSession; binding: ActiveOwnerBinding } | undefined;
	let turnController = new AbortController();
	chat.turnController = turnController;
	try {
		opened = await repositorySession(context, claimantSessionId, member?.entryId, references);
		if (chat.agent !== opened.session || turnController.signal.aborted) {
			throw new Error("The Planner session changed before the turn started. Try again.");
		}
		// Drained rather than copied: what the agent has been told once should
		// not arrive again on the next turn.
		let backscroll = chat.backscroll;
		chat.backscroll = [];
		let promptReferences = [
			...backscroll.flatMap(said => said.references ?? []),
			...references,
		];
		retainReferences(chat, promptReferences);
		let available = promptReferences.filter(reference => chat.referenceCache.has(reference.id));
		let prompt = compose(backscroll, handle, text, references, available);

		let result = await opened.session.stream(
			prompt,
			AbortSignal.any([opened.binding.signal, turnController.signal]),
		);
		for await (let part of result.fullStream) {
			translate(context, part);
			if (turnController.signal.aborted) break;
		}
		if (chat.interruption) throw new Error(chat.interruption);
	} catch (err) {
		console.error("[chat] turn failed:", err);
		if (!chat.closed) {
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: err instanceof Error ? err.message : "The agent could not be reached.",
				ts: now(),
			});
		}
		chat.interruption = undefined;
	} finally {
		chat.activeRequest = undefined;
		chat.turnController = undefined;
		try {
			await opened?.session.destroy();
		} finally {
			opened?.binding.release();
			if (chat.agent === opened?.session) chat.agent = undefined;
			chat.owner = undefined;
		}
		chat.messageIds = undefined;
		chat.writing = undefined;
		chat.tooling = undefined;
		settle(chat, server, room);
		if (!chat.closed) await context.persist();

		/*
		 * The agent's cursor outlives the turn by a moment.
		 *
		 * Somebody who looks over just as it finishes should still see where it
		 * got to, and a caret that vanished on the same tick as the last token
		 * would deny them that. Restarted rather than stacked: a queued turn
		 * starting inside the linger must cancel this, or it would take down a
		 * cursor the next turn had just placed.
		 */
		clearTimeout(chat.lingering);
		if (!chat.closed) {
			chat.lingering = setTimeout(() => {
				chat.lingering = undefined;
				Service.release(plan, server, room);
			}, LINGER_MS);
		}
	}

	if (chat.closed) return;
	let next = pending(chat);
	if (next) {
		await context.persist();
		if (chat.closed) return;
		queued(chat, server, room);
		let entry = next.message ? chat.entries.find(item => item.id === next.id) : undefined;
		if (entry) announce(server, room, entry);
		await run(
			context,
			next.handle,
			next.text,
			next.thread,
			next.sessionId ?? context.claimantSessionId,
			false,
			next.message && next.userId ? { entryId: next.id, userId: next.userId } : undefined,
			next.references,
		);
	} else {
		chat.busy = false;
		chat.turn = undefined;
		chat.acting = undefined;
		state(chat, server, room);
	}
}

function startRun(
	context: Room,
	handle: string,
	text: string,
	thread: string | undefined,
	claimantSessionId: string,
	reserved = false,
	member?: MemberRequest,
	references?: Wire.Reference[],
): void {
	if (context.chat.closed) return;
	let running = run(context, handle, text, thread, claimantSessionId, reserved, member, references);
	context.chat.running = running;
	void running.finally(() => {
		if (context.chat.running === running) context.chat.running = undefined;
	}).catch(() => {});
}

/**
 * The next queued turn worth running.
 *
 * A turn whose work is already done is dropped rather than run: four accepted
 * comments should not cost four passes over the plan when the agent dealt with
 * all of them in the first. Only something that queued behind a turn can be
 * spent, which is why the question is asked here and not when it was accepted.
 */
export function pending(chat: Chat): Waiting | undefined {
	let next = chat.waiting.shift();
	while (next?.spent?.()) next = chat.waiting.shift();
	if (next?.message) {
		let entry: MemberEntry = {
			id: next.id,
			author: { kind: "member", handle: next.handle },
			text: next.text,
			ts: now(),
			...(next.references?.length ? { references: next.references } : {}),
			...(next.delivery ? { delivery: next.delivery } : {}),
		};
		chat.entries.push(entry);
	}
	return next;
}

/** Project one AI SDK stream part into the shared Conversation. */
export function translate(context: Room, part: TextStreamPart<ToolSet>): void {
	let { chat, room, server } = context;
	let ids = chat.messageIds ??= new Map();
	switch (part.type) {
		case "finish":
			chat.tooling = undefined;
			return;
		case "text-start": {
			let id = ulid();
			ids.set(part.id, id);
			chat.writing = id;
			return;
		}
		case "text-delta": {
			let id = ids.get(part.id);
			if (!id) {
				id = ulid();
				ids.set(part.id, id);
			}
			let entry = chat.entries.find(item => item.id === id);
			if (!entry) {
				chat.writing = id;
				say(chat, server, room, {
					id,
					author: { kind: "agent" },
					text: part.text,
					ts: now(),
					streaming: true,
				});
			} else {
				entry.text += part.text;
				broadcast(server, room, { kind: "chat:delta", ts: 0, id, text: part.text });
			}
			responded(chat, server, room, part.text);
			return;
		}
		case "text-end": {
			let id = ids.get(part.id);
			let entry = chat.entries.find(item => item.id === id);
			if (entry) {
				delete entry.streaming;
				announce(server, room, entry);
			}
			if (chat.writing === id) chat.writing = undefined;
			return;
		}
		case "tool-call": {
			if (!ACTIVE_TOOLS.has(part.toolName)) {
				console.error(`[chat] boundary failure: inactive tool ${part.toolName}`);
				chat.interruption = `Planner tool boundary failure: ${part.toolName}`;
				chat.turnController?.abort();
				return;
			}
			chat.timings.set(part.toolCallId, Date.now());
			let activity: Wire.Activity = {
				id: part.toolCallId,
				name: part.toolName,
				status: "running",
				args: JSON.stringify(part.input, null, 2),
			};
			broadcast(server, room, {
				kind: "chat:tool",
				ts: 0,
				entry: attach(context, activity),
				activity,
			});
			return;
		}
		case "tool-result":
		case "tool-error":
		case "tool-output-denied": {
			let started = chat.timings.get(part.toolCallId);
			chat.timings.delete(part.toolCallId);
			let name = named(chat, part.toolCallId);
			let success = part.type === "tool-result";
			let output = part.type === "tool-result"
				? part.output
				: part.type === "tool-error"
				? part.error
				: "Refused.";
			let detail = name === "read_reference"
				? success
					? "Reference content was returned privately to the Planner."
					: "The reference could not be read."
				: typeof output === "string"
				? output
				: JSON.stringify(output);
			let activity: Wire.Activity = {
				id: part.toolCallId,
				name,
				status: success ? "done" : "failed",
				...(started ? { took: Date.now() - started } : {}),
				...(detail ? { result: detail.slice(0, 4_000) } : {}),
			};
			broadcast(server, room, {
				kind: "chat:tool",
				ts: 0,
				entry: attach(context, activity),
				activity,
			});
			return;
		}
		case "tool-approval-request":
			chat.interruption = "Planner tool approval was denied.";
			chat.turnController?.abort();
			return;
		case "error":
			chat.tooling = undefined;
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: part.error instanceof Error ? part.error.message : String(part.error),
				ts: now(),
			});
			return;
	}
}

/** What a running tool call was called, from where it was filed. */
function named(chat: Chat, id: string): string {
	for (let entry of chat.entries) {
		let found = entry.tools?.find(activity => activity.id === id);
		if (found) return found.name;
	}
	return "tool";
}

/**
 * File a tool call under the message that made it, and say which that was.
 *
 * A tool call that arrives before the agent has said anything — which is most
 * of them, since reading precedes writing — has no message to attach to yet.
 * It gets an entry of its own so the work is visible while it happens rather
 * than appearing retrospectively once the agent finishes talking.
 */
function attach(context: Room, activity: Wire.Activity): string {
	let { chat, room, server } = context;
	// Completion can arrive after idle; find its original activity by call id.
	let entry = chat.entries.find(item => item.tools?.some(tool => tool.id === activity.id))
		?? chat.entries.find(item => item.id === chat.tooling)
		?? chat.entries.find(item => item.id === chat.writing);
	if (entry && !entry.tools?.some(tool => tool.id === activity.id)) chat.tooling = entry.id;

	if (!entry) {
		entry = { id: ulid(), author: { kind: "agent" }, text: "", ts: now(), tools: [] };
		chat.tooling = entry.id;
		say(chat, server, room, entry);
	}

	entry.tools ??= [];
	let existing = entry.tools.findIndex(item => item.id === activity.id);
	if (existing >= 0) entry.tools[existing] = { ...entry.tools[existing], ...activity };
	else entry.tools.push(activity);
	return entry.id;
}

export async function resetAgent(
	chat: Chat,
	sessionId?: string,
	revision?: number,
	reason?: string,
): Promise<void> {
	let binding = chat.owner ?? chat.openingOwner;
	if (
		!binding
		|| (sessionId && binding.sessionId !== sessionId)
		|| (revision !== undefined && binding.revision !== revision)
	) return;
	chat.lifecycle++;
	chat.activeRequest = undefined;
	if (reason && chat.turnController) chat.interruption = reason;
	chat.turnController?.abort();
	chat.referenceCache.clear();
	chat.bootstrapEntries = undefined;
	chat.openingOwner = undefined;
}

/** Let go of the session. The conversation is resumable by id. */
export async function close(chat: Chat): Promise<void> {
	chat.closed = true;
	chat.lifecycle++;
	chat.activeRequest = undefined;
	chat.waiting = [];
	chat.turnController?.abort();
	chat.referenceCache.clear();
	chat.bootstrapEntries = undefined;
	chat.openingOwner = undefined;
	clearTimeout(chat.lingering);
	chat.lingering = undefined;
	await Promise.all([chat.sending, chat.running]);
}
