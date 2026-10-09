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
import { verifiedCheckout } from "../harness/atomic/checkout";
import { rememberCheckout } from "../harness/atomic/workspace";
import { plannerInstructions } from "../agent/planner";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { DocumentRoom, ResearchWorkspaceRequest } from "../agent/tools";
import * as Service from "../plan/service";
import { instruction } from "@chopin/protocol/address";

import { annotatedText, compose, referenceCatalog, remember } from "./address";
import { createNotices } from "./notices";
import { createJobQueue, finishJob, jobReason, type JobTurn, safeProjection } from "./job-queue";
import { translateJob } from "./job-translate";
import { argsText, outputText } from "./activity";
import { watchJobAbort } from "./job-fence";
import { JOB_TOOLS } from "../agent/job-scope";
import type { JobOutcome } from "../conversation-plan/jobs";
export type { Announcer, NoticeInput } from "./notices";
import { broadcast, fail, reply, tell } from "../wire";
import { MAX_MESSAGE_BYTES, REQUEST_ID } from "./limits";
import {
	availableVisualPreview,
	type VisualPreviewCapability,
} from "../visual-decisions/capability";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat as Wire, ConversationPlan, Request } from "@chopin/protocol";
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
const MAX_SESSION_REFERENCES = 50;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

type Delivery = {
	destination: Wire.Destination;
	requestFingerprint: string;
	canonicalFingerprint: string;
};

type MemberEntry = Wire.Entry & { delivery?: Delivery };

/** How long the agent's cursor stays where it finished, after a turn ends. */
const LINGER_MS = 5_000;

/**
 * A queued message, with what the queue needs and clients do not.
 *
 * `spent` is asked, just before the turn would run, whether somebody else has
 * already done the work. It is a function rather than a flag because the answer
 * is only knowable at that moment — and `JSON.stringify` drops it, so the wire
 * shape stays exactly `Wire.Waiting`.
 */
export type Waiting = Wire.Waiting & {
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
	/** A queued background turn, resolved only after its scope is cleaned up. */
	job?: JobTurn;
	posted?: boolean;
	/** MCP caller whose instruction this is; it never claims ownership without their login. */
	invokedBy?: string;
};

export type ActiveMemberRequest = {
	entryId: string;
	userId: string;
	handle: string;
	text: string;
	claimantSessionId: string | undefined;
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
	job?: ConversationPlan.Job;
	jobOutput?: string;
	jobFailures?: number;
	jobFailureCode?: "source-shape";
	jobCalls?: Map<string, string>;
	jobToolNames?: ReadonlySet<string>;
	/** The job shifted from the queue while its handoff save is pending. */
	handoffJob?: JobTurn;
	entries: Wire.Entry[];
	waiting: Waiting[];
	/** Serializes complete member send acceptance, including asynchronous resolution and persistence. */
	sending: Promise<void>;
	/** Work admitted to the send FIFO, including the operation currently resolving. */
	pendingSends: number;
	/** Per-turn owner for revocation and credential rotation fencing. */
	openingOwner?: { sessionId: string; generation: number; revision: number };
	/** Current session. Disposable per turn, except a full Planner session kept while it owns workflow runs. */
	agent?: PlannerSession;
	/** The Planner session kept past its turn, with its owner binding, until its workflow runs finish. */
	retained?: Retained;
	/** Live and paused workflow runs of the retained session. */
	runs?: Wire.Runs;
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
	/** Settles a host tool's row when its own execution ends, ahead of the harness's step-end result. */
	toolFinished?: (id: string, output: unknown, success: boolean) => void;
	/** Shows a tool's partial output as it arrives, ahead of the harness's step-end part. */
	toolProgress?: (id: string, output: unknown) => void;
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
 * Come back with what was said before, and the workflow runs shown then.
 *
 * An entry that was still streaming when the process went away never finished,
 * so the flag is cleared: it is as complete as it is ever going to be, and
 * leaving it set would show a spinner nothing will ever stop. Runs still live
 * then have no session now, so they come back stopped.
 */
export function restore(entries: Wire.Entry[], runs?: Wire.Run[]): Chat {
	let restoredRuns = restoreRuns(runs);
	return {
		...(restoredRuns ? { runs: restoredRuns } : {}),
		entries: entries.map(entry => {
			let { streaming: _streaming, ...rest } = entry;
			return rest.tools?.some(tool => tool.status === "running")
				? {
					...rest,
					tools: rest.tools.map(tool =>
						tool.status === "running" ? { ...tool, status: "failed" as const } : tool
					),
				}
				: rest;
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

function begin(handle: string, entryOffset: number): Wire.Turn {
	let startedAt = Date.now();
	return {
		id: ulid(),
		handle,
		started: Math.floor(startedAt / 1000),
		entryOffset,
		startedAt,
		responded: false,
	};
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
	let { delivery, ...entry } = value as MemberEntry;
	return delivery?.destination === "planner" ? { ...entry, to: "planner" } : entry;
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
		...(chat.runs ? { runs: chat.runs } : {}),
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
		...(chat.runs ? { runs: chat.runs } : {}),
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
	/**
	 * Login session that may claim Planner ownership for this room's turns.
	 * Absent for an MCP caller without a live browser login: their instruction
	 * runs only under an owner the channel already has.
	 */
	claimantSessionId: string | undefined;
	repository: HostedRepository;
	activeOwner?: () => Promise<ActiveOwnerBinding | undefined>;
	persist: (chat?: () => Pick<Chat, "entries" | "runs">) => Promise<void>;
	commitRoomMessage?: (entry: Wire.Entry) => Promise<void>;
	roomMessagePublished?: () => void;
	openPlannerSession?: typeof import("../harness/session")["openPlannerSession"];
	invokedBy?: string;
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
	visualPreview?: VisualPreviewCapability;
	/** Keeps the room loaded while a retained Planner still owns workflow runs; returns the release. */
	hold?: () => () => void;
};

type Retained = {
	session: PlannerSession;
	binding: ActiveOwnerBinding;
	release: () => Promise<void>;
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

/**
 * Accept an MCP instruction without waiting for its Planner turn.
 *
 * The caller is attributed on the posted message, and the turn runs under the
 * channel's Planner owner. A checkout matters only to the atomic harness, which
 * verifies it before anything is posted and remembers it for the channel.
 */
export async function invoke(
	context: Room,
	user: { id: string; login: string },
	text: string,
	checkout?: string,
): Promise<
	| "planner-unavailable"
	| "planner-owner-unavailable"
	| "planner-queue-full"
	| "checkout-unverified"
	| undefined
> {
	let { chat, server, room } = context;
	if (chat.pendingSends >= MAX_PENDING_SENDS) return "planner-queue-full";
	chat.pendingSends++;
	let post = async () => {
		if (!context.config.agent || chat.closed) return "planner-unavailable" as const;
		let verified: string | undefined;
		if (checkout !== undefined && context.config.harness === "atomic") {
			verified = await verifiedCheckout(context.repository, checkout);
			if (!verified) return "checkout-unverified" as const;
		}
		try {
			await resolveOwner(context.auth, context.repository, room, context.claimantSessionId);
		} catch {
			return "planner-owner-unavailable" as const;
		}
		if (chat.closed) return "planner-unavailable" as const;
		if (chat.busy && chat.waiting.length >= MAX_QUEUE) return "planner-queue-full" as const;
		let entry: Wire.Entry = {
			id: ulid(),
			author: { kind: "member", handle: user.login },
			text,
			ts: now(),
		};
		chat.entries.push(entry);
		try {
			await context.persist();
		} catch (error) {
			chat.entries = chat.entries.filter(value => value !== entry);
			throw error;
		}
		if (chat.closed) return "planner-unavailable" as const;
		if (verified) rememberCheckout(room, verified);
		announce(server, room, entry);
		if (chat.busy) {
			chat.waiting.push({
				id: entry.id,
				handle: user.login,
				text,
				message: true,
				posted: true,
				sessionId: context.claimantSessionId,
				userId: user.id,
				invokedBy: user.id,
			});
			queued(chat, server, room);
		} else {
			startRun(
				{ ...context, invokedBy: user.id },
				user.login,
				text,
				undefined,
				context.claimantSessionId,
				false,
				{ entryId: entry.id, userId: user.id },
			);
		}
		return undefined;
	};
	let accepted = chat.sending.then(post, post);
	let completed = accepted.finally(() => chat.pendingSends--);
	chat.sending = completed.then(() => {}, () => {});
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
		if (!context.commitRoomMessage) chat.entries.push(entry);
		try {
			if (context.commitRoomMessage) await context.commitRoomMessage(entry);
			else await context.persist();
		} catch {
			if (!context.commitRoomMessage) {
				chat.entries = chat.entries.filter(value => value.id !== entry.id);
			}
			return fail(ws, msg.rid, "could not save message");
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id, queued: false });
		announce(server, room, entry);
		context.roomMessagePublished?.();
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
	chat.turn = begin(handle, chat.entries.length + 1);
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
export let { notice, noticeOnce, noticeExclusive, refreshNoticeExclusive } = createNotices({
	now,
	announce,
});

function instructionNotice(context: Room, text: string): void | Promise<void> {
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
	let announced = instructionNotice(context, said);
	return announced instanceof Promise ? announced.then(proceed) : proceed();
}

let jobState = safeProjection(state);
let jobQueued = safeProjection(queued);
let { job, cancelQueuedJobs, stopAfterPersistenceFailure } = createJobQueue({
	queued: jobQueued,
	state: jobState,
	startRun,
	MAX_QUEUE,
});
export { cancelQueuedJobs, job };

/** Withdraw a queued message. Only whoever wrote it may. */
export function unqueue(context: Room, ws: Socket, msg: Request<Wire.Unqueue>): void {
	let { chat, room, server } = context;
	let found = chat.waiting.find(item => item.id === msg.id);
	if (!found || found.job || found.handle !== ws.data.handle) return;
	chat.waiting = chat.waiting.filter(item => item.id !== msg.id);
	queued(chat, server, room);
}

/**
 * Stop the running turn and pause the Planner's workflow runs, so both hold
 * until someone resumes them. Anyone may, and the transcript says who did.
 */
type RunsSnapshot = ReturnType<NonNullable<PlannerSession["runs"]>>;
type StoppingRuns = {
	pause: Promise<void>;
	targets: Set<string>;
	pausedTargets: Set<string>;
	reset: boolean;
	settled: boolean;
	paused: boolean;
	unwatch?: () => void;
};

const stoppingRuns = new WeakMap<PlannerSession, StoppingRuns>();

function observeStoppingRuns(stopping: StoppingRuns, runs: RunsSnapshot): void {
	if (!runs) return;
	for (let id of runs.paused) if (stopping.targets.has(id)) stopping.pausedTargets.add(id);
	stopping.reset = runs.active.some(id =>
		!stopping.targets.has(id) || stopping.pausedTargets.has(id)
	);
}

function clearStoppingRuns(session: PlannerSession, stopping: StoppingRuns): void {
	if (stoppingRuns.get(session) !== stopping) return;
	stoppingRuns.delete(session);
	stopping.unwatch?.();
}

export async function abort(context: Room, ws: Socket): Promise<void> {
	let { chat, room, server } = context;
	let turn = chat.busy && !chat.turnController?.signal.aborted
		? chat.turnController
		: undefined;
	let session = chat.retained?.session ?? chat.agent;
	let runs = session?.runs?.();
	let live = (runs?.active.length ?? 0) > 0;
	let notice = (paused: boolean) =>
		say(chat, server, room, {
			id: ulid(),
			author: { kind: "system" },
			text: paused
				? `@${ws.data.handle} stopped the Planner and paused its workflows.`
				: `@${ws.data.handle} stopped the turn.`,
			ts: now(),
		});
	let stopping = session && stoppingRuns.get(session);
	if (stopping) observeStoppingRuns(stopping, runs);
	if (session && stopping?.settled && stopping.paused && stopping.reset) {
		clearStoppingRuns(session, stopping);
		stopping = undefined;
	}
	if (stopping) {
		if (turn) {
			turn.abort();
			notice(false);
		}
		await stopping.pause;
		return;
	}
	if (!turn && !live) return;
	if (live && session?.pauseRuns) {
		let pauseRuns = session.pauseRuns;
		let stopping: StoppingRuns = {
			pause: Promise.resolve(),
			targets: new Set(runs?.active ?? []),
			pausedTargets: new Set(),
			reset: false,
			settled: false,
			paused: false,
		};
		stopping.pause = Promise.resolve().then(async () => {
			try {
				await pauseRuns.call(session);
				stopping.paused = true;
			} catch (err) {
				console.error("[chat] pausing workflow runs failed:", err);
			}
			notice(stopping.paused);
		});
		stoppingRuns.set(session, stopping);
		stopping.unwatch = session.watchRuns?.(next => {
			observeStoppingRuns(stopping, next);
			if (stopping.settled && stopping.paused && stopping.reset) {
				clearStoppingRuns(session, stopping);
			}
		});
		turn?.abort();
		try {
			await stopping.pause;
		} finally {
			stopping.settled = true;
			observeStoppingRuns(stopping, session.runs?.());
			if (!stopping.paused || stopping.reset) clearStoppingRuns(session, stopping);
		}
		return;
	}
	turn?.abort();
	notice(false);
}

/** Resume the workflow runs the Planner paused. Anyone may, and the transcript says who did. */
export async function resume(context: Room, ws: Socket): Promise<void> {
	let { chat, room, server } = context;
	let session = chat.retained?.session;
	if (!session?.resumeRuns || !session.runs?.()?.paused.length) return;
	let text = `@${ws.data.handle} resumed the Planner's workflows.`;
	try {
		await session.resumeRuns();
	} catch (err) {
		console.error("[chat] resuming workflow runs failed:", err);
		text = "The Planner's workflows could not be resumed.";
	}
	say(chat, server, room, { id: ulid(), author: { kind: "system" }, text, ts: now() });
}

/** Pause or resume one workflow run of the retained Planner. Anyone may, and the transcript says who did. */
export async function controlRun(
	context: Room,
	ws: Socket,
	frame: { kind: "chat:pause-run" | "chat:resume-run"; runId?: unknown },
): Promise<void> {
	let { chat, room, server } = context;
	let session = chat.retained?.session;
	let run = typeof frame.runId === "string"
		? chat.runs?.find(candidate => candidate.id === frame.runId)
		: undefined;
	let runs = session?.runs?.();
	if (!session || !run) return;
	let pausing = frame.kind === "chat:pause-run";
	if (pausing ? !runs?.active.includes(run.id) : !runs?.paused.includes(run.id)) return;
	let control = pausing ? session.pauseRun : session.resumeRun;
	if (!control) return;
	let text = `@${ws.data.handle} ${pausing ? "paused" : "resumed"} ${run.name}.`;
	try {
		await control(run.id);
	} catch (err) {
		console.error(`[chat] ${pausing ? "pausing" : "resuming"} workflow run failed:`, err);
		text = `${run.name} could not be ${pausing ? "paused" : "resumed"}.`;
	}
	say(chat, server, room, { id: ulid(), author: { kind: "system" }, text, ts: now() });
}

const ENDED_RUN: Partial<Record<Wire.Run["status"], string>> = {
	finished: "finished",
	blocked: "ended blocked",
	failed: "failed",
	stopped: "was stopped",
};

/**
 * The run cards Chat shows after the retained session reports `incoming`. Ended
 * cards stay until a new run starts in the document. With no report, the session
 * was let go, so a card still marked live becomes stopped.
 */
export function mergeRuns(
	previous: Wire.Run[],
	incoming: Wire.Run[] | undefined,
	at: number,
): Wire.Run[] {
	if (!incoming) return previous.map(run => ENDED_RUN[run.status] ? run : stopped(run, at));
	let known = new Set(previous.map(run => run.id));
	if (incoming.some(run => !known.has(run.id))) return incoming;
	let reported = new Set(incoming.map(run => run.id));
	return [...previous.filter(run => ENDED_RUN[run.status] && !reported.has(run.id)), ...incoming];
}

function stopped(run: Wire.Run, at: number): Wire.Run {
	return { ...run, status: "stopped", ended: run.ended ?? at, waiting: 0 };
}

/** Run cards restored with the document; no session survives a reload of the room, so live ones were stopped. */
export function restoreRuns(runs: Wire.Run[] | undefined): Wire.Run[] | undefined {
	return runs?.length ? mergeRuns(runs, undefined, now()) : undefined;
}

const publishing = new WeakMap<Chat, Promise<void>>();
const owners = new WeakMap<Chat, Map<string, PlannerSession>>();
const unsaved = new WeakMap<PlannerSession, Runs>();
const gone = new WeakSet<PlannerSession>();

type Runs = { active: string[]; paused: string[]; cards?: Wire.Run[] };

/**
 * Show the session's runs, keeping ended ones as summary cards until the next
 * run starts, store them with the document so a reload keeps them, and say once
 * in the transcript when one ends. A card belongs to the session that reported
 * it: a report or release only changes its own session's cards.
 */
function publishRuns(
	context: Room,
	session: PlannerSession,
	runs: Runs | undefined,
	releasing = false,
): Promise<void> {
	let known = owners.get(context.chat) ?? new Map<string, PlannerSession>();
	owners.set(context.chat, known);
	for (let run of runs?.cards ?? []) known.set(run.id, session);
	let turn = (publishing.get(context.chat) ?? Promise.resolve()).then(() =>
		publishReport(context, session, runs, releasing)
	);
	publishing.set(context.chat, turn);
	return turn;
}

async function publishReport(
	context: Room,
	session: PlannerSession,
	runs: Runs | undefined,
	releasing: boolean,
): Promise<void> {
	let { chat, room, server } = context;
	let at = now();
	let known = owners.get(chat)!;
	let prior = chat.runs ?? [];
	let before = new Map(prior.map(run => [run.id, run.status]));
	let theirs = (run: Wire.Run) => {
		let holder = known.get(run.id);
		return holder !== undefined && holder !== session && !gone.has(holder);
	};
	let others = prior.filter(theirs);
	let mine = prior.filter(run => !theirs(run)).map(run =>
		known.get(run.id) === session || ENDED_RUN[run.status] ? run : stopped(run, at)
	);
	let own = mergeRuns(mine, runs?.cards, at);
	if (releasing) own = mergeRuns(own, undefined, at);
	let fresh = (runs?.cards ?? []).some(run => !before.has(run.id));
	let cards = [...others.filter(run => fresh ? !ENDED_RUN[run.status] : true), ...own];
	let position = (run: Wire.Run) => {
		let index = prior.findIndex(value => value.id === run.id);
		return index < 0 ? prior.length : index;
	};
	cards.sort((a, b) => position(a) - position(b));
	// A new run replaces ended cards, including ones this report has just stopped; those still
	// get their one finish message.
	let shown = new Set(cards.map(run => run.id));
	let replaced = mine.filter(run => !shown.has(run.id));
	let finished: Wire.Entry[] = [];
	for (let run of [...cards, ...replaced]) {
		let ended = ENDED_RUN[run.status];
		let previous = before.get(run.id);
		if (!ended || (previous && ENDED_RUN[previous])) continue;
		let minutes = Math.max(1, Math.round(((run.ended ?? run.updated) - run.started) / 60));
		finished.push({
			id: ulid(),
			author: { kind: "system" },
			text: `${run.name} ${ended} after ${minutes} min.`,
			ts: now(),
		});
	}
	let next = cards.length ? cards : undefined;
	try {
		await context.persist(() => ({ entries: [...chat.entries, ...finished], runs: next }));
	} catch (err) {
		console.error("[chat] storing workflow runs failed:", err);
		if (releasing) unsaved.delete(session);
		else if (runs) unsaved.set(session, runs);
		return;
	}
	unsaved.delete(session);
	chat.entries.push(...finished);
	chat.runs = next;
	for (let entry of finished) announce(server, room, entry);
	state(chat, server, room);
}

/**
 * Keep a Planner session that still owns workflow runs instead of destroying
 * it with its turn: the runs belong to the session, and the next turn reuses
 * it so the Planner can still see and steer them. It is let go once every run
 * has finished, when its owner binding ends, or when the chat closes.
 */
function retain(
	context: Room,
	opened: { session: PlannerSession; binding: ActiveOwnerBinding },
): boolean {
	let { chat } = context;
	let runs = opened.session.runs?.();
	if (chat.retained && chat.retained.session !== opened.session) return false;
	if (!runs || opened.binding.signal.aborted) return false;
	if (!runs.active.length && !runs.paused.length) {
		void publishRuns(context, opened.session, runs);
		return false;
	}
	let report = (next: typeof runs) => publishRuns(context, opened.session, next);
	if (!chat.retained) {
		let unhold = context.hold?.();
		let stopWatching = opened.session.watchRuns?.(next => {
			if (chat.retained?.session !== opened.session) return;
			void report(next);
			if (next.active.length || next.paused.length) return;
			let releaseWhenIdle = async () => {
				if (chat.busy) await chat.running;
				if (chat.busy || chat.retained?.session !== opened.session) return;
				let current = opened.session.runs?.();
				if (!current || current.active.length || current.paused.length) return;
				await chat.retained.release();
			};
			void releaseWhenIdle().catch(err =>
				console.error("[chat] releasing completed workflow session failed:", err)
			);
		});
		let released: Promise<void> | undefined;
		let retained: Retained = {
			...opened,
			release: () =>
				released ??= (async () => {
					if (chat.retained === retained) chat.retained = undefined;
					stopWatching?.();
					opened.binding.signal.removeEventListener("abort", ended);
					try {
						await opened.session.destroy();
					} finally {
						opened.binding.release();
						unhold?.();
						if (chat.agent === opened.session) {
							chat.agent = undefined;
							if (!chat.busy) chat.owner = undefined;
						}
						await publishing.get(chat);
						await publishRuns(context, opened.session, unsaved.get(opened.session), true);
						gone.add(opened.session);
					}
				})(),
		};
		let ended = () => void retained.release();
		opened.binding.signal.addEventListener("abort", ended, { once: true });
		chat.retained = retained;
	}
	void report(runs);
	return true;
}

function currentMemberRequest(chat: Chat): ActiveMemberRequest | undefined {
	let active = chat.activeRequest;
	if (
		!active || chat.closed || !chat.busy || chat.lifecycle !== active.lifecycle
		|| chat.turn?.id !== active.turnId || !active.userId
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
	let preview = availableVisualPreview(context.visualPreview) ? context.visualPreview : undefined;
	return {
		id: room,
		plan,
		server,
		publish: mutation => Service.publish(plan, server, room, mutation, { agent: true }),
		persist: context.persist,
		exclusive: action => Service.exclusive(plan, action),
		anchors: () => Service.anchors(plan, server, room),
		changes: found => Service.changes(plan, server, room, found),
		jobs: context.jobs,
		currentMemberRequest: () => currentMemberRequest(chat),
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
		...(preview
			? {
				createVisualRequest: async () => {
					let active = currentMemberRequest(chat);
					let controller = chat.turnController;
					if (!active || chat.job || controller?.signal.aborted) {
						throw new Error(
							"a current foreground member request is required for a visual preview",
						);
					}
					return preview.request(
						active,
						() =>
							!chat.job && chat.turnController === controller
							&& !controller?.signal.aborted && currentMemberRequest(chat) === active,
					);
				},
			}
			: {}),
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
	claimantSessionId: string | undefined,
	currentEntryId?: string,
	currentReferences: Wire.Reference[] = [],
): Promise<{ session: PlannerSession; binding: ActiveOwnerBinding }> {
	let retained = context.chat.retained;
	// A background job keeps its isolated session: it never borrows or ends the retained Planner.
	if (retained && !context.chat.job) {
		if (!retained.binding.signal.aborted && await retained.binding.revalidate()) {
			context.chat.agent = retained.session;
			return { session: retained.session, binding: retained.binding };
		}
		await retained.release();
	}
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
			visualPreview: context.visualPreview,
			instructions: workspace =>
				plannerInstructions(
					`${repository.owner}/${repository.name}`,
					bootstrap,
					workspace,
					context.visualPreview,
				),
			model: context.config.model,
			harness: context.config.harness,
		});
		if (!result.ok) throw new Error(`Planner session unavailable (${result.error.kind})`);
		opened = result.value;
		if (
			chat.lifecycle !== lifecycle || chat.openingOwner !== openingOwner
			|| binding.signal.aborted || !await binding.revalidate()
		) throw new Error("The Planner session changed while opening. Try again.");
		chat.agent = opened;
		chat.owner = openingOwner;
		if (!chat.job) consumeBootstrapBackscroll(chat);
		else chat.bootstrapEntries = undefined;
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

/**
 * The channel's Planner owner, claimed for the claimant when it has none.
 * Without a claimant only an owner the channel already has will do.
 */
export async function resolveOwner(
	auth: HostedAuth,
	repository: HostedRepository,
	channelId: string,
	claimantSessionId: string | undefined,
) {
	let ownership = claimantSessionId
		? await auth.storage.channels.claimAgentOwner(channelId, claimantSessionId, new Date())
		: (await auth.storage.channels.readAgent(channelId, new Date()))?.agent;
	let ownerSessionId = ownership?.ownerSessionId;
	if (!ownership || !ownerSessionId) {
		throw new Error("This channel's Copilot owner is unavailable.");
	}
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
function settle(chat: Chat, server: Server<SocketData>, room: string, stopped: boolean): void {
	for (let entry of chat.entries) {
		let running = entry.tools?.filter(tool => tool.status === "running");
		if (!entry.streaming && !running?.length) continue;
		for (let activity of running ?? []) {
			let started = chat.timings.get(activity.id) ?? activity.startedAt;
			let finished: Wire.Activity = {
				...activity,
				status: "failed",
				result: stopped ? "Turn stopped." : "Turn ended without a result.",
				...(started ? { took: Date.now() - started } : {}),
			};
			Object.assign(activity, finished);
			broadcast(server, room, { kind: "chat:tool", ts: 0, entry: entry.id, activity: finished });
		}
		delete entry.streaming;
		announce(server, room, entry);
	}
	chat.timings.clear();
}

/** Run one turn, then drain whatever queued up behind it. */
async function run(
	context: Room,
	handle: string,
	text: string,
	thread: string | undefined,
	claimantSessionId: string | undefined,
	reserved = false,
	member?: MemberRequest,
	references: Wire.Reference[] = [],
	jobTurn?: JobTurn,
): Promise<void> {
	let { chat, plan, room, server } = context;
	if (chat.closed) {
		if (jobTurn) finishJob(jobTurn, { status: "failed", reason: "The document closed." });
		return;
	}

	if (!reserved) {
		chat.busy = true;
		chat.turn = begin(handle, chat.entries.length);
		chat.acting = thread;
		(jobTurn ? jobState : state)(chat, server, room);
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
	if (jobTurn) {
		chat.job = jobTurn.job;
		chat.jobOutput = undefined;
		chat.jobFailures = 0;
		chat.jobFailureCode = undefined;
		chat.jobCalls = new Map();
	}
	let sendStarted = false;
	let outcome: JobOutcome | undefined;
	let persistenceError: unknown;
	let releaseJobAbort: (() => void) | undefined;

	let opened: { session: PlannerSession; binding: ActiveOwnerBinding } | undefined;
	let turnController = new AbortController();
	chat.turnController = turnController;
	let held = jobTurn ? chat.retained : undefined;
	let heldOwner = chat.owner;
	let heldReferences = held ? new Map(chat.referenceCache) : undefined;
	try {
		opened = await repositorySession(context, claimantSessionId, member?.entryId, references);
		if (chat.agent !== opened.session || turnController.signal.aborted) {
			throw new Error("The Planner session changed before the turn started. Try again.");
		}
		chat.jobToolNames = jobTurn
			? new Set(opened.session.activeTools ?? PLANNER_TOOL_NAMES)
			: undefined;
		let prompt: string;
		if (jobTurn) {
			prompt = jobTurn.prompt;
		} else {
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
			prompt = compose(backscroll, handle, text, references, available, !!context.invokedBy);
		}
		sendStarted = true;
		if (!jobTurn) {
			chat.toolFinished = (id, output, success) => {
				if (!turnController.signal.aborted) finished(context, id, output, success);
			};
			chat.toolProgress = (id, output) => progressed(context, id, output);
		}
		let signal = AbortSignal.any([opened.binding.signal, turnController.signal]);
		if (jobTurn) releaseJobAbort = watchJobAbort(chat, jobTurn, signal);
		let result = await opened.session.stream(prompt, signal);
		for await (let part of result.fullStream) {
			if (turnController.signal.aborted) break;
			translate(context, part);
		}
		if (jobTurn && chat.closed) throw new Error("The document closed.");
		if (chat.interruption) throw new Error(chat.interruption);
		if (jobTurn && turnController.signal.aborted) throw new Error("The Planner turn was stopped.");
		if (jobTurn) {
			outcome = chat.jobOutput === undefined
				? {
					status: "failed",
					reason: chat.jobFailureCode
						?? `The Planner ended without calling ${JOB_TOOLS[jobTurn.job.kind]}.`,
				}
				: { status: "done", output: chat.jobOutput };
		}
	} catch (err) {
		console.error("[chat] turn failed:", err);
		if (jobTurn) {
			outcome = chat.closed
				? { status: "failed", reason: "The document closed." }
				: {
					status: sendStarted || chat.interruption ? "failed" : "skipped",
					reason: jobReason(err),
				};
		} else if (!chat.closed && (!turnController.signal.aborted || chat.interruption)) {
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: err instanceof Error ? err.message : "The agent could not be reached.",
				ts: now(),
			});
		}
		chat.interruption = undefined;
	} finally {
		releaseJobAbort?.();
		chat.activeRequest = undefined;
		chat.turnController = undefined;
		chat.toolFinished = undefined;
		chat.toolProgress = undefined;
		let kept = false;
		try {
			if (opened && !chat.closed && !jobTurn) kept = retain(context, opened);
			if (!kept) {
				if (!jobTurn && chat.retained?.session === opened?.session) await chat.retained?.release();
				else await opened?.session.destroy();
			}
		} catch (err) {
			console.error("[chat] could not close a finished turn:", err);
			if (jobTurn) persistenceError = err;
			else {
				// Fence late tool work, then keep transcript persistence and queue cleanup reachable.
				let stopped = turnController.signal.aborted;
				turnController.abort();
				if (!stopped && !chat.closed) {
					try {
						say(chat, server, room, {
							id: ulid(),
							author: { kind: "system" },
							text: "The Planner session could not close cleanly. Try again.",
							ts: now(),
						});
					} catch (noticeError) {
						console.error("[chat] could not announce a failed turn:", noticeError);
					}
				}
			}
		} finally {
			if (!kept) {
				opened?.binding.release();
				if (chat.agent === opened?.session) chat.agent = undefined;
				chat.owner = undefined;
				// The job's own session briefly stood in for the retained one; hand it back,
				// with the references the retained Planner can read.
				if (held && chat.retained === held) {
					chat.agent = held.session;
					chat.owner = heldOwner;
					if (heldReferences) chat.referenceCache = heldReferences;
				}
			}
		}
		chat.messageIds = undefined;
		chat.writing = undefined;
		chat.tooling = undefined;
		settle(chat, server, room, turnController.signal.aborted);
		if (jobTurn) {
			chat.job = undefined;
			chat.jobOutput = undefined;
			chat.jobFailures = undefined;
			chat.jobFailureCode = undefined;
			chat.jobCalls = undefined;
		}
		chat.jobToolNames = undefined;
		try {
			if (!chat.closed) await context.persist();
		} catch (err) {
			persistenceError = err;
			console.error("[chat] could not save a finished turn:", err);
		}
		if (jobTurn) {
			if (chat.closed) outcome = { status: "failed", reason: "The document closed." };
			else if (persistenceError) {
				outcome = { status: "failed", reason: jobReason(persistenceError) };
			} else if (chat.interruption) {
				outcome = { status: "failed", reason: jobReason(chat.interruption) };
			}
		}

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

	if (persistenceError) {
		stopAfterPersistenceFailure(chat, server, room);
	}
	if (jobTurn) {
		finishJob(jobTurn, outcome ?? { status: "failed", reason: "The Planner turn ended." });
	}

	if (chat.closed) return;
	let next = pending(chat);
	while (next) {
		if (next.job) chat.handoffJob = next.job;
		try {
			await context.persist();
		} catch (err) {
			if (chat.handoffJob === next.job) chat.handoffJob = undefined;
			console.error("[chat] could not save a queued turn:", err);
			if (next.job) finishJob(next.job, { status: "failed", reason: jobReason(err) });
			stopAfterPersistenceFailure(chat, server, room);
			return;
		}
		if (chat.handoffJob === next.job) chat.handoffJob = undefined;
		if (chat.closed) {
			if (next.job) finishJob(next.job, { status: "failed", reason: "The document closed." });
			return;
		}
		if (next.job?.settled) {
			next = pending(chat);
			continue;
		}
		(next.job ? jobQueued : queued)(chat, server, room);
		let nextId = next.id;
		let entry = next.message ? chat.entries.find(item => item.id === nextId) : undefined;
		if (entry && !next.posted) announce(server, room, entry);
		await run(
			{ ...context, invokedBy: next.invokedBy },
			next.handle,
			next.text,
			next.thread,
			next.invokedBy ? next.sessionId : next.sessionId ?? context.claimantSessionId,
			false,
			next.message && next.userId ? { entryId: next.id, userId: next.userId } : undefined,
			next.references,
			next.job,
		);
		return;
	}
	chat.busy = false;
	chat.turn = undefined;
	chat.acting = undefined;
	(jobTurn ? jobState : state)(chat, server, room);
}

function startRun(
	context: Room,
	handle: string,
	text: string,
	thread: string | undefined,
	claimantSessionId: string | undefined,
	reserved = false,
	member?: MemberRequest,
	references?: Wire.Reference[],
	jobTurn?: JobTurn,
): void {
	if (context.chat.closed) {
		if (jobTurn) finishJob(jobTurn, { status: "failed", reason: "The document closed." });
		return;
	}
	let running = run(
		context,
		handle,
		text,
		thread,
		claimantSessionId,
		reserved,
		member,
		references ?? [],
		jobTurn,
	);
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
	if (next?.message && !next.posted) {
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
	if (chat.job || chat.jobToolNames) return translateJob(context, part);
	let ids = chat.messageIds ??= new Map();
	switch (part.type) {
		case "finish":
			chat.tooling = undefined;
			return;
		case "text-start": {
			let id = ulid();
			ids.set(part.id, id);
			chat.writing = id;
			chat.tooling = undefined;
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
				chat.tooling = undefined;
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
		case "tool-input-start": {
			if (!permitted(context, part.toolName)) return;
			begun(chat, part.id);
			publish(context, {
				id: part.id,
				name: part.toolName,
				status: "running",
				startedAt: chat.timings.get(part.id),
			});
			return;
		}
		case "tool-call": {
			if (!permitted(context, part.toolName)) return;
			begun(chat, part.toolCallId);
			publish(context, {
				id: part.toolCallId,
				name: part.toolName,
				status: "running",
				args: argsText(part.input),
				startedAt: chat.timings.get(part.toolCallId),
			});
			return;
		}
		case "tool-result":
		case "tool-error":
		case "tool-output-denied": {
			let preliminary = part.type === "tool-result" && part.preliminary === true;
			let success = part.type === "tool-result";
			let output = part.type === "tool-result"
				? part.output
				: part.type === "tool-error"
				? part.error
				: "Refused.";
			conclude(
				context,
				part.toolCallId,
				output,
				preliminary ? "running" : success ? "done" : "failed",
				success,
				part.type === "tool-output-denied",
			);
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

/**
 * Publish a tool's outcome once.
 *
 * The harness holds a host tool's result until its model step ends, so the
 * tool's own execution reports first and the buffered part finds the row
 * already settled with the real duration.
 */
function conclude(
	context: Room,
	id: string,
	output: unknown,
	status: Wire.ToolStatus,
	success: boolean,
	refused = false,
): void {
	let { chat } = context;
	let name = named(chat, id);
	let existing = tool(chat, id);
	if (existing && existing.status !== "running") return;
	let started = chat.timings.get(id);
	if (status !== "running") chat.timings.delete(id);
	let detail = name === "read_reference"
		? success
			? "Reference content was returned privately to the Planner."
			: "The reference could not be read."
		: outputText(output);
	publish(context, {
		id,
		name,
		status,
		...(refused ? { refused: true as const } : {}),
		...(started && status !== "running" ? { took: Date.now() - started } : {}),
		...(detail ? { result: detail } : {}),
	});
}

/** Whether the session offers this tool; one it does not offer ends the turn. */
function permitted(context: Room, name: string): boolean {
	let { chat } = context;
	if ((chat.agent?.activeTools ?? PLANNER_TOOL_NAMES).includes(name)) return true;
	console.error(`[chat] boundary failure: inactive tool ${name}`);
	chat.interruption = `Planner tool boundary failure: ${name}`;
	chat.turnController?.abort();
	return false;
}

function begun(chat: Chat, id: string): void {
	if (!chat.timings.has(id)) chat.timings.set(id, Date.now());
}

function publish(context: Room, activity: Wire.Activity): void {
	let { room, server } = context;
	broadcast(server, room, {
		kind: "chat:tool",
		ts: 0,
		entry: attach(context, activity),
		activity,
	});
}

/** A host tool's own execution ended; settle its open row now rather than at step end. */
export function finished(context: Room, id: string, output: unknown, success: boolean): void {
	if (tool(context.chat, id)?.status !== "running") return;
	conclude(context, id, output, success ? "done" : "failed", success);
}

/** A tool still running reported partial output; show it now. */
export function progressed(context: Room, id: string, output: unknown): void {
	if (tool(context.chat, id)?.status !== "running") return;
	conclude(context, id, output, "running", true);
}

function tool(chat: Chat, id: string): Wire.Activity | undefined {
	return chat.entries.flatMap(entry => entry.tools ?? []).find(item => item.id === id);
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
	if (chat.job) {
		chat.job = undefined;
		chat.jobOutput = undefined;
	}
	chat.turnController?.abort();
	chat.referenceCache.clear();
	chat.bootstrapEntries = undefined;
	chat.openingOwner = undefined;
}

/** Let go of the session. The conversation is resumable by id. */
export async function close(chat: Chat): Promise<void> {
	chat.closed = true;
	chat.job = undefined;
	chat.jobOutput = undefined;
	chat.lifecycle++;
	chat.activeRequest = undefined;
	for (let waiting of chat.waiting) {
		if (waiting.job) finishJob(waiting.job, { status: "failed", reason: "The document closed." });
	}
	if (chat.handoffJob) {
		finishJob(chat.handoffJob, { status: "failed", reason: "The document closed." });
		chat.handoffJob = undefined;
	}
	chat.waiting = [];
	chat.turnController?.abort();
	chat.referenceCache.clear();
	chat.bootstrapEntries = undefined;
	chat.openingOwner = undefined;
	clearTimeout(chat.lingering);
	chat.lingering = undefined;
	await Promise.all([chat.sending, chat.running]);
	await chat.retained?.release();
}
