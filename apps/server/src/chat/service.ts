/**
 * Chat.
 *
 * One transcript per room, shared by everyone in it, and one turn at a time.
 * Messages that address the agent are queued rather than refused while it is
 * working: the plan belongs to the agent for the length of a turn, but the
 * Chat does not, and silencing somebody because a colleague prompted
 * first is a poor way to run a room with two people in it.
 *
 * Ordinary conversation enters bounded context for the next turn. The optional
 * initiative scheduler can also propose a turn after saved human contributions
 * become quiet; explicit Planner messages continue to start immediately.
 *
 * Every message reaching the model is prefixed with its author's handle. The
 * agent is planning with a group, and "Alice prefers X, but Bob raised Y" is
 * the kind of thing it has to be able to say back.
 */

import { createHash } from "node:crypto";
import { imagePath } from "../images/format";

import { ulid } from "@chopin/dialect";

import { PLANNER_TOOL_NAMES } from "../harness/tool-names";
import type { PlannerFiles, PlannerSession } from "../harness/session";
import { verifiedCheckout } from "../harness/atomic/checkout";
import { rememberCheckout } from "../harness/atomic/workspace";
import { plannerInstructions } from "../agent/planner";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { DocumentRoom, ResearchWorkspaceRequest } from "../agent/tools";
import type { VisualAdmission } from "../agent/visual-admission";
import type { ChildDocuments } from "./children";
import * as Service from "../plan/service";
import { instruction } from "@chopin/protocol/address";
import { checkMessageAttachments, refusalText } from "@chopin/protocol/attachment";
import { COMMAND_KINDS } from "@chopin/protocol/commands";
import { UNREADABLE_NOTICE } from "@chopin/protocol/model-choice";
import { settledStages } from "@chopin/protocol/run-stages";

import { attachmentLimits } from "../attachments/limits";
import { wireAttachment } from "../attachments/wire";
import {
	annotatedText,
	commandReference,
	compose,
	focusContext,
	referenceCatalog,
	remember,
} from "./address";
import { createNotices } from "./notices";
import { ChatCommandError, ChatMentionError, ChatReferenceError } from "./references";
import {
	cancelledNotice,
	type Deferred,
	type DeferredConfig,
	insert,
	interruptedNotice,
	mark,
	move,
	newTurn,
} from "./deferred";
import { createJobQueue, finishJob, jobReason, type JobTurn, safeProjection } from "./job-queue";
import { translateJob } from "./job-translate";
import { argsText, outputText, textOutput } from "./activity";
import { toolErrorSchema } from "@chopin/agent-link";
import { watchJobAbort } from "./job-fence";
import { JOB_TOOLS } from "../agent/job-scope";
import type { Job, JobOutcome } from "../conversation-plan/jobs";
export type { Announcer, NoticeInput } from "./notices";
import { isChannelId } from "../channels/id";
import { holdsQuestion } from "../questions/records";
import { broadcast, fail, PASSING, reply, tell } from "../wire";
import { introduce } from "../people";
import { MAX_MESSAGE_BYTES } from "./limits";
import { contributed } from "./initiative";
import { checkPlannerReply, PlannerReplyError, publishPlannerReplies } from "./reply-policy";
import { TOOL_UNAVAILABLE, turnFailureOf } from "./turn-failure";
import { runDuration } from "./run-duration";
import type { InitiativeSchedule } from "./initiative-schedule";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat as Wire, ConversationPlan, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type {
	DeferredTurn,
	DeferredTurnChange,
	DeferredTurnOutcome,
	JsonValue,
} from "../storage/model";
import type { Decide } from "../conversation-plan/decisions";
import type { JevRequest } from "../conversation-plan/jev";
import type { HostedAuth } from "../auth/routes";
import type { PutRunStages } from "../storage/model";
import type { HostedRepository } from "../agent/repository";
import type { JobService } from "../jobs/service";
import type { Plan } from "../plan/service";
import type { Focus, Said } from "./address";
import type { ReferenceService } from "./references";
import type { Socket, SocketData } from "../wire";
import type { ToolError } from "@chopin/agent-link";

/** Beyond this the queue is a backlog nobody is going to read. */
const MAX_QUEUE = 20;
const MAX_PENDING_SENDS = 20;
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

/**
 * A queued message, with what the queue needs and clients do not.
 *
 * `spent` is asked, just before the turn would run, whether somebody else has
 * already done the work. It is a function rather than a flag because the answer
 * is only knowable at that moment — and `JSON.stringify` drops it, so the wire
 * shape stays exactly `Wire.Waiting`.
 */
export type Waiting = Wire.Waiting & {
	signal?: AbortSignal;
	readiness?: boolean;
	delivery?: Delivery;
	spent?: () => boolean;
	/** True when this came from the composer rather than another instruction. */
	message?: boolean;
	/** The comment thread this turn was started to act on, if one was. */
	thread?: string;
	/** Told how the turn went, before the queue moves on; see `Instruction`. */
	ended?: Instruction["ended"];
	started?: Instruction["started"];
	/** Login session whose Copilot entitlement owns this queued turn. */
	sessionId?: string;
	/** Verified member identity, retained only for a queued composer message. */
	userId?: string;
	/** A queued background turn, resolved only after its scope is cleaned up. */
	job?: JobTurn;
	posted?: boolean;
	/** MCP caller whose instruction this is; it never claims ownership without their login. */
	invokedBy?: string;
	/** The task draft this queued turn carries; it has no message to show in the queue. */
	draft?: string;
	/** The child the member had open, resolved when the message was accepted. */
	focus?: Focus;
	/** The images and files sent with this message, which its entry shows once it is in Chat. */
	attachments?: Wire.Attachment[];
	/** The child holding `thread`, when the thread is not in this document. */
	threadChannel?: string;
	/** See `Instruction`. */
	quiet?: boolean;
	/** The row that keeps this request while it waits; see `./deferred`. */
	deferred?: Deferred;
	/** The session opened for this request before its row moved, which its turn then runs in. */
	opened?: { session: PlannerSession; binding: ActiveOwnerBinding };
};

/** A request for implementation tasks, live while its turn is queued or running. */
export type TaskDraft = {
	id: string;
	planRevision: number;
	state: "queued" | "running";
	/** The running turn, once it has begun. */
	turn?: string;
};

export type ActiveMemberRequest = {
	entryId: string;
	userId: string;
	handle: string;
	text: string;
	claimantSessionId: string | undefined;
	turnId: string;
	lifecycle: number;
	focus?: Focus;
};

type MemberRequest = Pick<ActiveMemberRequest, "entryId" | "userId" | "focus">;

/** How a turn started by an instruction finished, for whoever started it. */
export type Ended = {
	/** `skipped` means it never ran, because it was spent or withdrawn first. */
	status: "done" | "stopped" | "failed" | "skipped";
	/** The last thing the Planner said in Chat during the turn, if anything. */
	text?: string;
};

/** What a turn other than a message needs to say about itself. */
export type Instruction = {
	/** Cancels only this server-authored turn when its initiating context becomes stale. */
	signal?: AbortSignal;
	/** Server-authored review of blockers; never supplies an explicit member research request. */
	readiness?: boolean;
	spent?: () => boolean;
	thread?: string;
	/**
	 * Awaited once the turn has been persisted and before the next one starts,
	 * so whatever it records lands before anything the next turn does. Also
	 * called, with `skipped`, for a turn that never runs.
	 */
	ended?: (outcome: Ended) => void | Promise<void>;
	/** Called when the turn begins running, so its owner knows what it was shown. */
	started?: () => void;
	/** Shown on the transcript notice, so Chat can draw it as a comment card. */
	comment?: NonNullable<Wire.Entry["comment"]>;
	/** The child the turn is about; named ahead of the prompt like a member's focus. */
	focus?: Focus;
	/** The child holding `thread`, when the thread is not in this document. */
	threadChannel?: string;
	/** Kept out of the visible queue: its notice says why, and its text is for the Planner alone. */
	quiet?: boolean;
	/**
	 * The transcript notice's id, stable across restarts: a turn whose notice Chat already shows
	 * was started before and is not started again.
	 */
	notice?: string;
	/**
	 * Marks an instruction a person asked for, which is kept as a row when it cannot start at once:
	 * a comment note sent to Chopin, or an automatic follow-up an MCP caller asked for.
	 */
	defer?: { kind: "comment" | "invoke_system"; userId: string };
	/** The row that keeps this turn, once it has been queued; set by Chat. */
	deferred?: Deferred;
};

/**
 * A child room's way to its root's Chat, which is the only one.
 *
 * Each call opens the root's room and re-asks storage that the child still
 * belongs to it, so a child that moved, or a root that went away, refuses.
 */
export type RootChat = {
	id: string;
	/** Admission against the root's queue, opening the root's room if needed. */
	admission(thread: string): Promise<"running" | "queued" | "off" | "busy">;
	/** An explicit Planner turn on the root's Chat about a thread in this child. */
	instruct(handle: string, text: string, said: string, about: Instruction): Promise<void>;
	/** Whether the root's Chat is running or holding a turn for this child's thread. */
	working(thread: string): boolean;
};

/** Tell an instruction's owner how it went; their failure is theirs, not the queue's. */
async function report(about: Instruction | undefined, outcome: Ended): Promise<void> {
	if (!about?.ended) return;
	try {
		await about.ended(outcome);
	} catch (err) {
		console.error("[chat] an instruction's end could not be recorded:", err);
	}
}

/**
 * Set once the process is on its way out: no turn starts from then on, and a request that would
 * have started one waits in the queue, as it does behind a running turn.
 */
let startsHeld = false;

/** Stop starting turns. Pass `false` to start them again; only a test does. */
export function holdStarts(held = true): void {
	startsHeld = held;
}

/**
 * What a Chat that has closed says to a request. A process that is stopping says nothing at all:
 * the request was not taken, its browser keeps it and sends it again, with the same id, to the
 * next process, and a refusal now would show a message that is about to be delivered as one that
 * could not be sent.
 */
function refuseClosed(ws: Socket, rid: string): void {
	if (!startsHeld) fail(ws, rid, "chat is closed", PASSING);
}

/** Whether a new request waits in the queue: a turn is running, or none may start. */
/**
 * Whether people's requests fill the queue behind a machine that is there. Chopin's own background
 * jobs wait beside them and do not count, so one of them never makes a message that fits wait or
 * fail. Nothing fills the queue of a machine that is `away`: the requests are saved and kept
 * until it is back, and none is refused because it has been away long.
 */
function full(chat: Chat, away = false): boolean {
	return !away && chat.waiting.filter(item => !item.job).length >= MAX_QUEUE;
}

function occupied(chat: Chat): boolean {
	// Saved requests start in the order they were accepted, so a new one joins behind them.
	return chat.busy || !!chat.starting || startsHeld || chat.waiting.some(item => item.deferred);
}

/**
 * Cuts off the turn running now because the process is restarting: says so in the Chat, then
 * stops it. It is not run again, because it may already have changed the document.
 */
export function interrupt(chat: Chat, notice: string): void {
	if (!chat.busy || !chat.turnController || chat.turnController.signal.aborted) return;
	chat.interruption = notice;
	chat.restarted = true;
	chat.turnController.abort();
}

/** Resolves when the turn running now, and the ones it starts after it, have ended. */
export async function settled(chat: Chat): Promise<void> {
	await chat.running?.catch(() => {});
}

/**
 * Whether an instruction about `thread` would run now, wait, or be refused.
 *
 * Asked before anything is saved, so a full queue refuses a comment rather than
 * saving one nobody will act on. A thread that already has a turn waiting
 * folds into it instead of queueing again, so it never counts against the cap.
 */
export function admission(
	context: Pick<Room, "chat" | "config">,
	thread?: string,
	channel?: string,
	/** The machine is away: a request waits for it as it would behind a running turn. */
	away = false,
): "running" | "queued" | "off" | "busy" {
	let { chat, config } = context;
	if (!config.agent) return "off";
	if (thread && queuedFor(chat, thread, channel)) return "queued";
	if (!occupied(chat) && !away) return "running";
	return full(chat, away) ? "busy" : "queued";
}

/**
 * The waiting turn for a thread, if one is queued and still worth running.
 *
 * `channel` names the child holding the thread; absent, the thread is this document's.
 */
export function queuedFor(chat: Chat, thread: string, channel?: string): Waiting | undefined {
	return chat.waiting.find(item =>
		item.thread === thread && item.threadChannel === channel
		&& !item.message && !item.job && !item.draft && !item.spent?.()
	);
}

/** Whether a turn is running or waiting for a thread; `channel` as for `queuedFor`. */
export function workingFor(chat: Chat | undefined, thread: string, channel?: string): boolean {
	// A closed Chat runs nothing more, whatever its last turn left behind.
	if (!chat || chat.closed) return false;
	return chat.acting === thread && chat.actingChannel === channel
		|| !!queuedFor(chat, thread, channel);
}

export type Chat = {
	initiative?: InitiativeSchedule<import("./initiative").Source>;
	initiativePaused?: boolean;
	initiativeEnabled?: boolean;
	readiness?: boolean;
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
	/**
	 * A turn is being taken from the queue and has not begun, which can take a commit. Until it has,
	 * nothing else may start one: two turns would run at once, and the first to end would let a
	 * third in.
	 */
	starting?: boolean;
	/** The fallback notice the transcript last said, so a choice that stays gone is said once. */
	modelNotice?: string;
	/** Whether the composers were last told the choice could not be read, so only a change is sent. */
	modelUnreadable?: boolean;
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
	/** Child context shared by member requests and server-authored turns. */
	focus?: Focus;
	/**
	 * The comment thread the running turn is acting on.
	 *
	 * Read by `edit_plan`, so the prose a turn writes can be recorded as what
	 * that decision produced even when the agent forgets to say so itself.
	 */
	acting?: string;
	/** The child holding `acting`, or undefined when the thread is in this document. */
	actingChannel?: string;
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
	/** Decisions the running turn opened or repeated through `open_decisions`, new or not. */
	captured?: Set<string>;
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
	/** The document's live task draft; rebuilt from its row when the document opens. */
	draft?: TaskDraft;
	/** The running turn was cut off because the process is restarting. */
	restarted?: boolean;
	/**
	 * The machine could not open a session for the request at the head of the queue, which stays
	 * waiting. Nothing tries it again until something new says the machine may be there: a request
	 * accepted, the machine back, a login restored.
	 */
	unopened?: boolean;
	/** Says once what a queue that cannot start waits for. */
	/**
	 * Requests whose sender took them back before the server had them, most recent last. A send
	 * that arrives late, from a connection that was already lost, must not bring one back.
	 */
	retracted?: Set<string>;
	/**
	 * Messages whose save was answered as a passing trouble, though the commit may have gone through
	 * and only its answer been lost. Their rows are looked up when the sender sends them again and
	 * when the queue next starts, and put back in the queue and the transcript if they are there.
	 */
	unsure?: Set<string>;
};

const MAX_RETRACTED = 200;

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
export function restore(
	entries: Wire.Entry[],
	runs?: Wire.Run[],
	initiativePaused = false,
	keepRuns?: "live" | "down",
): Chat {
	let restoredRuns = keepRuns && runs?.length
		? runs.map(run => disconnected(run, keepRuns === "down"))
		: restoreRuns(runs);
	return {
		initiativePaused,
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

function requestFingerprint(
	msg: Request<Wire.Send>,
	principalId: string,
	actor?: string,
): string {
	let references = Array.isArray(msg.references)
		? msg.references.map(value => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			let item = value as unknown as Record<string, unknown>;
			return Object.keys(item).sort().map(key => [key, item[key]]);
		})
		: msg.references ?? [];
	// Appended only when present, so replays of entries saved before focus existed still match.
	let focus = (msg as { focus?: unknown }).focus;
	let attachments = (msg as { attachments?: unknown }).attachments;
	return digest(JSON.stringify([
		principalId,
		msg.to,
		msg.text,
		references,
		...(focus !== undefined ? [focus] : []),
		...(attachments !== undefined ? [{ attachments }] : []),
		...(actor ? [{ actor }] : []),
	]));
}

function canonicalFingerprint(
	destination: Wire.Destination,
	text: string,
	references: Wire.Reference[] = [],
): string {
	let targets = references.map(reference => {
		// Each kind is hashed by what makes it that reference, in a fixed order.
		let base = [reference.kind, reference.id, reference.start, reference.end, reference.label];
		switch (reference.kind) {
			case "command":
				return [...base, reference.name, reference.commandKind];
			case "heading":
				return [...base, reference.anchor, reference.level, reference.line];
			case "decision":
				return [...base, reference.decisionId];
			case "file":
				return [...base, reference.path];
			case "document":
				return [
					...base,
					reference.href,
					reference.repositoryId,
					reference.observedRevision,
					reference.channelId,
					reference.observedSourceHash,
				];
			case "research":
				return [
					...base,
					reference.href,
					reference.repositoryId,
					reference.observedRevision,
					reference.parentChannelId,
					reference.workspaceId,
				];
		}
	});
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
	// A message kept as a row is in the transcript and in the queue at once: one request.
	let parked = entries.length === 1 && waiting.length === 1 && !!waiting[0]!.posted;
	if (!parked && entries.length + waiting.length !== 1) {
		fail(ws, msg.rid, "chat request id conflicts with existing state");
		return true;
	}
	let entry = entries[0];
	let queued = parked ? undefined : waiting[0];
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

/**
 * A retried send the process no longer holds, found among the rows: it gets the answer it first
 * got, and one that was deleted is refused rather than sent again.
 */
async function replayRow(
	context: Room,
	ws: Socket,
	msg: Request<Wire.Send>,
	requestId: string,
	fingerprint: string,
): Promise<boolean> {
	if (!context.deferred) return false;
	let row = await context.plan.persistence.storage.deferredTurns.get(context.room, requestId);
	if (!row) return false;
	let saved = row.delivery as { destination?: unknown; requestFingerprint?: unknown } | undefined;
	if (saved?.destination !== msg.to || saved?.requestFingerprint !== fingerprint) {
		fail(ws, msg.rid, "chat request id was reused with different content");
		return true;
	}
	if (row.state === "cancelled" && !context.chat.entries.some(entry => entry.id === requestId)) {
		fail(ws, msg.rid, "this message was deleted");
		return true;
	}
	// Kept by a commit whose answer was lost: it is back in the queue before it is answered as kept.
	if (context.chat.unsure?.has(requestId)) {
		if (row.state === "waiting") {
			await adopt(context, row);
			void kick(context);
		}
		context.chat.unsure.delete(requestId);
	}
	reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: requestId, queued: row.state === "waiting" });
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
 * None of it belongs in the wire projection. Queued background jobs are not messages
 * anyone sent, so they stay off the wire entirely.
 */
function visible(chat: Chat): Wire.Waiting[] {
	return chat.waiting.filter(item =>
		!item.draft && !item.job && !item.quiet && !(item.deferred && item.message)
	).map((
		{ handle, id, text, references },
	) => ({
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
		participation: { enabled: !!chat.initiativeEnabled, paused: false },
	});
	// After the history, which ends whatever an earlier connection was told of it.
	if (chat.modelUnreadable) tell(ws, { kind: "chat:model-unreadable", ts: 0, unreadable: true });
}

export type Room = {
	investigations?: import("../agent/experiment-tools").InvestigationTools;
	chat: Chat;
	plan: Plan;
	server: Server<SocketData>;
	room: string;
	config: Config;
	/** The deployment's decisions boundary; absent when no decisions model is configured. */
	decide?: Decide;
	/** Shared admission for new Planner-authored passages, independent of harness or request kind. */
	visualAdmission?: VisualAdmission;
	auth: HostedAuth;
	/**
	 * Login session that may claim Planner ownership for this room's turns.
	 * Absent for an MCP caller without a live browser login: their instruction
	 * runs only under an owner the channel already has.
	 */
	claimantSessionId: string | undefined;
	repository: HostedRepository;
	/**
	 * Under `HARNESS=remote`, how to attach a Planner when none is attached, or
	 * undefined while one is. Planner requests are refused before anything is
	 * posted or queued, and only an attachment takes Planner ownership.
	 */
	plannerNotAttached?: () => Promise<string | undefined>;
	/**
	 * Under `HARNESS=remote`, waits a bounded time for a Planner a machine is starting for this
	 * document, before an `@chopin` message or `invoke_planner` is checked for one.
	 */
	plannerStarting?: () => Promise<void>;
	/**
	 * Under `HARNESS=remote`, whether a Planner is attached now, as opposed to expected back. A
	 * person's request is accepted either way; only an attached Planner starts it.
	 */
	plannerReady?: () => Promise<boolean>;
	/** Set in hosted mode: a request that cannot start at once is kept as a row. */
	deferred?: DeferredConfig;
	activeOwner?: () => Promise<ActiveOwnerBinding | undefined>;
	/** Saves the Chat, with changes to deferred requests in the same transaction, and what each did. */
	persist: (
		chat?: () => Pick<Chat, "entries" | "runs" | "initiativePaused">,
		deferred?: DeferredTurnChange[],
	) => Promise<DeferredTurnOutcome[] | void>;
	initiativePresent?: (sessionId: string, actor: string) => boolean;
	initiativeAuthorize?: (sessionId: string, actor: string) => Promise<boolean>;
	commitRoomMessage?: (entry: Wire.Entry) => Promise<void>;
	roomMessagePublished?: () => void;
	/** Runs only after a new member entry is durably saved and its human turn reserved. */
	memberMessagePersisted?: (entry: Wire.Entry, claimantSessionId: string | undefined) => void;
	openPlannerSession?: typeof import("../harness/session")["openPlannerSession"];
	/**
	 * What the document's chosen model and thinking level come to for the next turn, checked against
	 * what its harness offers now. Absent where nothing can be chosen.
	 */
	modelChoice?: () => Promise<import("./model-choice").TurnModel>;
	/**
	 * The commands the document's Planner offers now, which a command in a message is checked
	 * against: none where it reports none, and none for a Planner that is not attached.
	 */
	commands?: () => Promise<Wire.CommandOption[] | undefined>;
	/**
	 * Whether a path is a file of the document's repository, as the sender's session can read it,
	 * or undefined when the repository's files cannot be listed. Absent where nothing lists them.
	 */
	fileExists?: (path: string, sessionId: string) => Promise<boolean | undefined>;
	/**
	 * Whether the model the next turn would run reads images, by the catalog its harness reports
	 * now. Absent where nothing is known, which reads as no.
	 */
	readsImages?: () => Promise<boolean>;
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
	/** Keeps the room loaded while a retained Planner still owns workflow runs; returns the release. */
	hold?: () => () => void;
	/** The task draft the turn being started carries. */
	draft?: string;
	/** This root's children. Absent when this room is itself a child. */
	children?: ChildDocuments;
	/** Set only when this room is a child: its root, which owns the only Chat. */
	rootChannelId?: string;
	/** Set only when this room is a child: how its comments reach the root's Chat. */
	root?: RootChat;
};

type Retained = {
	session: PlannerSession;
	binding: ActiveOwnerBinding;
	release: () => Promise<void>;
	/** Called when `binding` ends; a rebound session watches its new binding with it. */
	ended: () => void;
};

const RENEWED_CREDENTIAL = new Set(["credential-rotated", "credential-expired"]);

/** Whether a binding ended because its GitHub credential was renewed, not because its owner left. */
function credentialRenewed(binding: ActiveOwnerBinding): boolean {
	let reason = binding.signal.reason;
	return binding.signal.aborted && reason instanceof Error
		&& RENEWED_CREDENTIAL.has(reason.message);
}

/**
 * Gives a retained session whose owner's credential was renewed a binding to the renewed one, so
 * work a disconnected Planner kept does not end with the old credential. False when the owner is
 * no longer the same, or the session cannot take a new binding.
 */
async function rebindRetained(context: Room, retained: Retained): Promise<boolean> {
	let previous = retained.binding;
	if (!retained.session.rebind || !credentialRenewed(previous)) return false;
	let binding = await context.activeOwner?.();
	if (!binding) return false;
	if (
		binding.ownerSessionId !== previous.ownerSessionId
		|| binding.ownerGeneration !== previous.ownerGeneration
		|| binding.repository.id !== previous.repository.id
		|| context.chat.retained !== retained
	) {
		binding.release();
		return false;
	}
	retained.session.rebind(binding);
	retained.binding = binding;
	binding.signal.addEventListener("abort", retained.ended, { once: true });
	return true;
}

/**
 * Take a message.
 *
 * A room message appears immediately. A planner message queued behind another
 * turn stays visibly queued until that turn actually begins, then moves into
 * the transcript exactly once. The destination, rather than its prose, decides
 * which lifecycle it takes.
 */
export async function send(context: Room, ws: Socket, msg: Request<Wire.Send>): Promise<void> {
	if (
		context.chat.pendingSends >= MAX_PENDING_SENDS
		&& !(msg.to === "planner" && await awayOrNot(context))
	) {
		fail(ws, msg.rid, "too many chat messages are waiting to be processed", PASSING);
		return;
	}
	context.chat.pendingSends++;
	let enqueue = () => {
		// Nothing a send throws says its message is at fault: it is answered as a passing trouble, and
		// the browser sends it again with the same request id.
		let process = () =>
			processSend(context, ws, msg).catch(err => {
				console.error("[chat] a send failed before it was kept:", err);
				fail(ws, msg.rid, "could not send message", PASSING);
			});
		let accepted = context.chat.sending.then(process, process);
		let completed = accepted.finally(() => context.chat.pendingSends--);
		context.chat.sending = completed.then(() => {}, () => {});
		return completed;
	};
	// A message to the Planner waits for one that is starting before it joins the queue, so the
	// room's messages never wait with it. With rows it waits for nothing: it is kept at once, and
	// starts when the Planner arrives.
	if (msg.to !== "planner" || !context.plannerStarting) return enqueue();
	if (context.deferred) {
		void context.plannerStarting().catch(() => {});
		return enqueue();
	}
	return context.plannerStarting().catch(() => {}).then(enqueue);
}

/**
 * Accept an MCP instruction without waiting for its Planner turn.
 *
 * The caller is attributed on the posted message, and the turn runs under the
 * channel's Planner owner. A checkout matters only to the atomic harness, which
 * verifies it before anything is posted and remembers it for the channel. With a
 * `notice`, an automatic follow-up, Chat shows that notice instead of a message
 * and the text goes to the Planner alone, as for any other instruction.
 */
export async function invoke(
	context: Room,
	user: { id: string; login: string; avatarUrl?: string },
	text: string,
	checkout?: string,
	focus?: Focus,
	/** Called once, when the invoked turn ends or is dropped; never when this refuses. */
	settled?: () => void,
	notice?: string,
): Promise<
	| "planner-unavailable"
	| "planner-not-attached"
	| "planner-owner-unavailable"
	| "planner-queue-full"
	| "checkout-unverified"
	| undefined
> {
	let { chat, server, room } = context;
	if (chat.pendingSends >= MAX_PENDING_SENDS && !await awayOrNot(context)) {
		return "planner-queue-full";
	}
	chat.pendingSends++;
	let post = async () => {
		if (!context.config.agent || chat.closed || context.rootChannelId) {
			return "planner-unavailable" as const;
		}
		// With rows, a request for a machine that is away waits for it, and its owner is checked
		// when it starts.
		let waitsAway = context.deferred ? await away(context) : false;
		if (!context.deferred && await context.plannerNotAttached?.()) {
			return "planner-not-attached" as const;
		}
		let verified: string | undefined;
		if (checkout !== undefined && context.config.harness === "atomic") {
			verified = await verifiedCheckout(context.repository, checkout);
			if (!verified) return "checkout-unverified" as const;
		}
		if (!waitsAway) {
			try {
				await resolveOwner(context.auth, context.repository, room, claimant(context));
			} catch {
				return "planner-owner-unavailable" as const;
			}
		}
		if (chat.closed) return "planner-unavailable" as const;
		if ((context.deferred || occupied(chat)) && full(chat, waitsAway)) {
			return "planner-queue-full" as const;
		}
		if (notice !== undefined) {
			if (verified) rememberCheckout(room, verified);
			await instruct(context, user.login, text, notice, {
				quiet: true,
				...(context.deferred ? { defer: { kind: "invoke_system" as const, userId: user.id } } : {}),
				...(focus ? { focus } : {}),
				...(settled ? { ended: () => settled() } : {}),
			});
			return undefined;
		}
		let waits = !!context.deferred || occupied(chat);
		let entry: Wire.Entry = {
			id: ulid(),
			author: { kind: "member", handle: user.login },
			text,
			ts: now(),
			...(context.deferred
				? { deliveryState: "sent" as const }
				: {}),
		};
		let turn = context.deferred && waits
			? newTurn({
				documentId: room,
				kind: "invoke_planner",
				request: entry.id,
				handle: user.login,
				userId: user.id,
				text,
				focus,
				claimant: context.claimantSessionId,
				owner: chat.owner?.sessionId,
			})
			: undefined;
		chat.entries.push(entry);
		try {
			await save(context, turn ? [insert(turn)] : undefined);
		} catch (error) {
			chat.entries = chat.entries.filter(value => value !== entry);
			throw error;
		}
		if (chat.closed) return "planner-unavailable" as const;
		if (verified) rememberCheckout(room, verified);
		// The caller has no socket in the room, so nothing else has told it who they are.
		introduce(server, room, { login: user.login, avatarUrl: user.avatarUrl });
		announce(server, room, entry);
		if (waits || occupied(chat)) {
			chat.waiting.push({
				id: entry.id,
				handle: user.login,
				text,
				message: true,
				posted: true,
				sessionId: context.claimantSessionId,
				userId: user.id,
				invokedBy: user.id,
				...(focus ? { focus } : {}),
				...(settled ? { ended: settled } : {}),
				...(turn ? { deferred: mark(turn, entry.id) } : {}),
			});
			queued(chat, server, room);
			if (turn) void kick(context);
		} else {
			startRun(
				{ ...context, invokedBy: user.id },
				user.login,
				text,
				undefined,
				context.claimantSessionId,
				false,
				{ entryId: entry.id, userId: user.id, ...(focus ? { focus } : {}) },
			);
			// Started here, so this promise is this turn's own (and the queue it drains).
			let running = chat.running;
			if (settled) {
				if (running) void running.finally(settled).catch(() => {});
				else settled();
			}
		}
		chat.initiative?.cancel();
		context.memberMessagePersisted?.(entry, context.claimantSessionId);
		return undefined;
	};
	let enqueue = () => {
		let accepted = chat.sending.then(post, post);
		let completed = accepted.finally(() => chat.pendingSends--);
		chat.sending = completed.then(() => {}, () => {});
		return completed;
	};
	// It waits for a Planner that is starting before it joins the queue, as `@chopin` does, unless
	// rows keep it meanwhile.
	if (!context.plannerStarting) return enqueue();
	if (context.deferred) {
		void context.plannerStarting().catch(() => {});
		return enqueue();
	}
	return context.plannerStarting().catch(() => {}).then(enqueue);
}

/**
 * The files a send names, read from the server's own records and bound to the message in the order
 * given. A file must be an upload of this sender to this document that no other message carries;
 * the count and total are the server's; and an image goes only where the model reads images. A
 * refusal is the words for the person, and `PASSING` where only storage was at fault.
 */
async function acceptAttachments(
	context: Room,
	ws: Socket,
	requestId: string,
	destination: Wire.Destination,
	supplied: unknown,
): Promise<{ attachments: Wire.Attachment[] } | { refusal: string; code?: typeof PASSING }> {
	let limits = attachmentLimits(context.config);
	if (!limits) return { refusal: "files are not accepted here" };
	if (
		!Array.isArray(supplied) || supplied.length === 0
		|| supplied.some(id => typeof id !== "string" || id.length === 0 || id.length > 128)
		|| new Set(supplied).size !== supplied.length
	) return { refusal: "invalid files" };
	if (supplied.length > limits.maxCount) return { refusal: refusalText("too-many", { limits }) };
	let { chatAttachments } = context.auth.storage;
	let ids = supplied as string[];
	try {
		let found = await Promise.all(ids.map(id => chatAttachments.get(context.room, id)));
		let mine = found.filter(value =>
			value && value.uploadedBy === ws.data.principalId
			&& (value.entryId === undefined || value.entryId === requestId)
		);
		if (mine.length !== ids.length) return { refusal: refusalText("gone") };
		let files = mine as NonNullable<(typeof mine)[number]>[];
		let message = checkMessageAttachments(files.map(value => value.size), limits);
		if (message) return { refusal: refusalText(message, { limits }) };
		if (
			destination === "planner" && files.some(value => value.kind === "image")
			&& !await context.readsImages?.()
		) return { refusal: refusalText("images-unavailable") };
		if (
			!await chatAttachments.bind({
				channelId: context.room,
				userId: ws.data.principalId,
				ids,
				entryId: requestId,
			})
		) return { refusal: refusalText("gone") };
		return { attachments: files.map(wireAttachment) };
	} catch (err) {
		console.error("[chat] could not read a message's files:", err);
		return { refusal: "files are temporarily unavailable", code: PASSING };
	}
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
	if (context.rootChannelId) {
		return fail(ws, msg.rid, "this document's Chat is on its root document");
	}
	if (typeof msg.text !== "string") return fail(ws, msg.rid, "invalid message text");
	if (Buffer.byteLength(msg.text) > MAX_MESSAGE_BYTES) {
		return fail(ws, msg.rid, "chat message exceeds the 64 KiB limit");
	}
	let request = requestFingerprint(msg, ws.data.principalId, ws.data.actor?.id);
	if (replay(chat, ws, msg, requestId, request)) return;
	if (destination === "planner" && await replayRow(context, ws, msg, requestId, request)) return;
	if (destination === "planner" && chat.retracted?.has(requestId)) {
		return fail(ws, msg.rid, "this message was deleted");
	}
	if (chat.closed) return refuseClosed(ws, msg.rid);
	let focus: Focus | undefined;
	let suppliedFocus = (msg as { focus?: unknown }).focus;
	if (suppliedFocus !== undefined) {
		if (typeof suppliedFocus !== "string" || !isChannelId(suppliedFocus)) {
			return fail(ws, msg.rid, "invalid chat focus");
		}
		if (destination === "planner") {
			let child: Awaited<ReturnType<ChildDocuments["resolve"]>>;
			try {
				child = await context.children?.resolve(suppliedFocus);
			} catch (err) {
				// Storage detail stays in the log; the member only learns the child is unavailable,
				// for now: a child that did not resolve for storage's sake may resolve in a moment.
				console.error("[chat] could not resolve the focused child document:", err);
				return fail(ws, msg.rid, "the open child document is unavailable", PASSING);
			}
			if (!child) return fail(ws, msg.rid, "the open child document is unavailable");
			focus = { channelId: child.id, title: child.title };
		}
	}
	let projected: { text: string; references?: Wire.Reference[] };
	try {
		if (context.references) {
			// Asked only when a command is in the message: nothing else reads what the Planner offers.
			let commands = Array.isArray(msg.references)
					&& msg.references.some(item => (item as { kind?: unknown })?.kind === "command")
				? await context.commands?.()
				: undefined;
			projected = await context.references.resolve({
				channelId: room,
				repositoryId: context.repository.id,
				text: msg.text,
				destination,
				requests: msg.references,
				...(commands ? { commands } : {}),
				...(context.fileExists
					? { fileExists: (path: string) => context.fileExists!(path, ws.data.sessionId) }
					: {}),
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
	} catch (err) {
		// Only a reference the server found at fault is final. Anything else it threw, such as a
		// storage error while it looked a target up, passes: the same message is sent again.
		// A refused command says why: it is what the person reads under the draft they keep.
		if (err instanceof ChatCommandError || err instanceof ChatMentionError) {
			return fail(ws, msg.rid, err.message);
		}
		if (err instanceof ChatReferenceError) {
			return fail(ws, msg.rid, "invalid or unavailable chat reference");
		}
		console.error("[chat] could not resolve a message's references:", err);
		return fail(ws, msg.rid, "chat references are temporarily unavailable", PASSING);
	}
	let text = projected.text;
	let references = projected.references;
	let attached: Wire.Attachment[] = [];
	let suppliedAttachments = (msg as { attachments?: unknown }).attachments;
	if (suppliedAttachments !== undefined) {
		let accepted = await acceptAttachments(
			context,
			ws,
			requestId,
			destination,
			suppliedAttachments,
		);
		if ("refusal" in accepted) return fail(ws, msg.rid, accepted.refusal, accepted.code);
		attached = accepted.attachments;
	}
	if (!text && attached.length === 0) return fail(ws, msg.rid, "message text is empty");
	if (chat.closed) return refuseClosed(ws, msg.rid);
	let savedDelivery = delivery(destination, request, text, references);
	let withAttachments = attached.length ? { attachments: attached } : {};

	if (destination === "room") {
		let entry: MemberEntry = {
			id: requestId,
			author: { kind: "member", handle },
			text,
			ts: now(),
			...(references?.length ? { references } : {}),
			...withAttachments,
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
			return fail(ws, msg.rid, "could not save message", PASSING);
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id, queued: false });
		announce(server, room, entry);
		context.roomMessagePublished?.();
		context.memberMessagePersisted?.(entry, context.claimantSessionId);
		chat.backscroll = remember(chat.backscroll, {
			entryId: entry.id,
			handle,
			text,
			...(references?.length ? { references } : {}),
		});
		contributed(context, ws, entry, suppliedFocus as string | undefined);
		return;
	}
	if (!context.config.agent) {
		let entries: MemberEntry[] = [{
			id: requestId,
			author: { kind: "member", handle },
			text,
			ts: now(),
			...(references?.length ? { references } : {}),
			...withAttachments,
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
			return fail(ws, msg.rid, "could not save message", PASSING);
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entries[0]!.id, queued: false });
		for (let entry of entries) announce(server, room, entry);
		context.memberMessagePersisted?.(entries[0]!, context.claimantSessionId);
		return;
	}

	// A person's request is accepted whether or not a Planner is there, and kept as a row until a
	// session is open on the machine and a turn starts it, even when nothing is running, so a hard
	// stop or a machine that cannot open one loses nothing. Without rows (local mode with a Planner
	// on the same computer) it is refused when none is attached.
	let awayNow = false;
	if (context.deferred) {
		awayNow = await away(context);
	} else {
		let unattached = await context.plannerNotAttached?.();
		if (unattached) return fail(ws, msg.rid, unattached, "planner-not-attached");
	}
	if (chat.closed) return refuseClosed(ws, msg.rid);

	chat.initiative?.cancel();
	if (context.deferred) {
		return deferMessage(context, ws, msg, {
			away: awayNow,
			requestId,
			handle,
			text,
			references,
			attachments: attached,
			delivery: savedDelivery,
			focus,
		});
	}
	if (occupied(chat)) {
		if (full(chat)) {
			// A tab that sends request ids keeps the message and sends it again once there is room,
			// so only one that cannot is told in the Chat.
			if (suppliedRequestId === undefined) {
				say(chat, server, room, {
					id: ulid(),
					author: { kind: "system" },
					text: "The queue is full. Wait for the current turn to finish.",
					ts: now(),
				});
			}
			return fail(ws, msg.rid, "the reply queue is full", "planner-queue-full");
		}
		let waiting: Waiting = {
			id: requestId,
			handle,
			text,
			...(references?.length ? { references } : {}),
			...withAttachments,
			delivery: savedDelivery,
			message: true,
			sessionId: context.claimantSessionId,
			userId: ws.data.principalId,
			...(focus ? { focus } : {}),
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
		...withAttachments,
		delivery: savedDelivery,
		// Sent until its prompt is on its way to the machine; the turn says when.
		...(context.deferred ? { deliveryState: "sent" as const } : {}),
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
		return fail(ws, msg.rid, "could not save message", PASSING);
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
		{ entryId: entry.id, userId: ws.data.principalId, ...(focus ? { focus } : {}) },
		references,
	);
	context.memberMessagePersisted?.(entry, context.claimantSessionId);
}

/** Saves the Chat, with changes to rows when there are any, and what each did. */
function save(
	context: Room,
	changes: DeferredTurnChange[] | undefined,
): Promise<DeferredTurnOutcome[] | void> {
	return changes?.length ? context.persist(undefined, changes) : context.persist();
}

/** Whether a Planner request has to wait for a machine that is not attached. */
export async function away(context: Pick<Room, "plannerReady" | "deferred">): Promise<boolean> {
	return context.deferred && context.plannerReady ? !await context.plannerReady() : false;
}

/**
 * `away`, where a check that fails says the machine is there. Asked only of a request that finds
 * too many being saved at once: a machine that is away keeps every one, however many, and only a
 * request for a machine that is there is turned away.
 */
function awayOrNot(context: Pick<Room, "plannerReady" | "deferred">): Promise<boolean> {
	return away(context).catch(() => false);
}

/**
 * Keep a message to the Planner that cannot start now: in the transcript at once, as sent, and as
 * a row in the commit that saves it, so the acknowledgement is never ahead of what survives.
 */
async function deferMessage(
	context: Room,
	ws: Socket,
	msg: Request<Wire.Send>,
	input: {
		away: boolean;
		requestId: string;
		handle: string;
		text: string;
		references?: Wire.Reference[];
		attachments?: Wire.Attachment[];
		delivery: Delivery;
		focus?: Focus;
	},
): Promise<void> {
	let { chat, room, server } = context;
	// Not a message that cannot be delivered: its sender's browser keeps it and sends it again, with
	// the same request id, once there is room, so nothing is said in the Chat each time.
	if (full(chat, input.away)) {
		return fail(ws, msg.rid, "the queue is full", "planner-queue-full");
	}
	let { requestId, handle, text, references, focus } = input;
	let withAttachments = input.attachments?.length ? { attachments: input.attachments } : {};
	let entry: MemberEntry = {
		id: requestId,
		author: { kind: "member", handle },
		text,
		ts: now(),
		...(references?.length ? { references } : {}),
		...withAttachments,
		delivery: input.delivery,
		deliveryState: "sent",
	};
	let turn = newTurn({
		documentId: room,
		kind: "composer",
		request: requestId,
		handle,
		userId: ws.data.principalId,
		text,
		references,
		delivery: { ...input.delivery, entry: requestId } as unknown as JsonValue,
		focus,
		claimant: context.claimantSessionId,
		owner: chat.owner?.sessionId,
	});
	chat.entries.push(entry);
	let outcomes: DeferredTurnOutcome[] | void;
	try {
		outcomes = await context.persist(undefined, [insert(turn)]);
	} catch {
		chat.entries = chat.entries.filter(value => value !== entry);
		(chat.unsure ??= new Set()).add(requestId);
		return fail(ws, msg.rid, "could not save message", PASSING);
	}
	let outcome = outcomes?.[0];
	if (outcome && !(outcome.action === "insert" && outcome.status === "inserted")) {
		chat.entries = chat.entries.filter(value => value !== entry);
		return fail(ws, msg.rid, "chat request id conflicts with existing state");
	}
	chat.waiting.push({
		id: requestId,
		handle,
		text,
		...(references?.length ? { references } : {}),
		...withAttachments,
		delivery: input.delivery,
		message: true,
		posted: true,
		sessionId: context.claimantSessionId,
		userId: ws.data.principalId,
		...(focus ? { focus } : {}),
		deferred: mark(turn, requestId),
	});
	reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: requestId, queued: true });
	announce(server, room, entry);
	context.memberMessagePersisted?.(entry, context.claimantSessionId);
	void kick(context);
}

/** Say something in the transcript without asking the agent for anything. */
export let { notice, noticeOnce, noticeExclusive, refreshNoticeExclusive } = createNotices({
	now,
	announce,
});

function instructionNotice(
	context: Room,
	text: string,
	comment?: Instruction["comment"],
	id = ulid(),
): void | Promise<void> {
	return postNotice(context, text, comment, id).then(() => {});
}

/** Saves a system notice, with changes to deferred requests in the same commit, then shows it. */
function postNotice(
	context: Room,
	text: string,
	comment: Instruction["comment"] | undefined,
	id: string,
	changes?: DeferredTurnChange[],
): Promise<DeferredTurnOutcome[]> {
	let { chat, room, server } = context;
	let entry: Wire.Entry = {
		id,
		author: { kind: "system" },
		text,
		ts: now(),
		...(comment ? { comment } : {}),
	};
	chat.entries.push(entry);
	return Promise.resolve(save(context, changes)).then(outcomes => {
		announce(server, room, entry);
		return outcomes ?? [];
	});
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
	// A child has no Chat to explain the turn in, and its root's Planner reaches it there.
	if (context.rootChannelId) return report(about, { status: "skipped" });
	let proceed = (): void | Promise<void> => {
		if (chat.closed || about.spent?.() || about.signal?.aborted) {
			return report(about, { status: "skipped" });
		}
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

		// A thread that already has a turn waiting is told about the newer note
		// by that turn: its prompt is replaced, since it reads the whole thread.
		let folded = about.thread ? queuedFor(chat, about.thread, about.threadChannel) : undefined;
		if (folded) {
			folded.handle = handle;
			folded.text = text;
			return;
		}

		if (occupied(chat)) {
			if (full(chat)) {
				say(chat, server, room, {
					id: ulid(),
					author: { kind: "system" },
					text: "The queue is full. Wait for the current turn to finish.",
					ts: now(),
				});
				return report(about, { status: "failed" });
			}
			let { comment: _comment, notice: _notice, ...rest } = about;
			chat.waiting.push({
				id: ulid(),
				handle,
				text,
				...rest,
				sessionId: context.claimantSessionId,
			});
			return queued(chat, server, room);
		}

		startRun(context, handle, text, about, context.claimantSessionId);
	};
	if (about.spent?.() || about.signal?.aborted) return report(about, { status: "skipped" });
	// Automatic participation replies like any member would, so it announces nothing.
	if (!said) return proceed();
	if (about.defer && context.deferred) {
		return instructDeferred(context, handle, text, said, about, proceed);
	}
	let announced = instructionNotice(context, said, about.comment, about.notice);
	return announced instanceof Promise ? announced.then(proceed) : proceed();
}

/**
 * An instruction a person asked for, which waits as a row when a turn is running, none may start
 * or the machine is away, with its notice and the row saved in one commit.
 */
async function instructDeferred(
	context: Room,
	handle: string,
	text: string,
	said: string,
	about: Instruction,
	proceed: () => void | Promise<void>,
): Promise<void> {
	let { chat, config, room, server } = context;
	let folded = about.thread ? queuedFor(chat, about.thread, about.threadChannel) : undefined;
	let waits = !folded && config.agent && !chat.closed && !full(chat, await away(context));
	if (!waits || !about.defer) {
		await instructionNotice(context, said, about.comment, about.notice);
		return proceed();
	}
	let id = about.notice ?? ulid();
	let turn = newTurn({
		documentId: room,
		kind: about.defer.kind,
		request: id,
		handle,
		userId: about.defer.userId,
		text,
		focus: about.focus,
		thread: about.thread,
		threadChannel: about.threadChannel,
		claimant: context.claimantSessionId,
		owner: chat.owner?.sessionId,
	});
	let outcome = (await postNotice(context, said, about.comment, id, [insert(turn)]))[0];
	// A row the document already had for this request, or for this thread, keeps its place.
	if (outcome && outcome.action === "insert" && outcome.status !== "inserted") return;
	if (chat.closed) return;
	let { comment: _comment, notice: _notice, defer: _defer, ...rest } = about;
	chat.waiting.push({
		id,
		handle,
		text,
		...rest,
		sessionId: context.claimantSessionId,
		deferred: mark(turn),
	});
	queued(chat, server, room);
	void kick(context);
}

function drafting(
	server: Server<SocketData>,
	room: string,
	draft: TaskDraft,
	state: "queued" | "running" | "ended",
): void {
	broadcast(server, room, {
		kind: "implementation:drafting",
		ts: 0,
		id: draft.id,
		planRevision: draft.planRevision,
		state,
	});
}

/**
 * The draft that is still queued or running, if one is.
 *
 * A record whose queue entry or turn has gone without reaching the end of a
 * turn (a closed room, a queue cleared after a failed save) is dropped here
 * rather than tracked down every path that can discard it.
 */
function liveDraft(chat: Chat): TaskDraft | undefined {
	let draft = chat.draft;
	if (!draft) return;
	let alive = draft.state === "queued"
		? chat.waiting.some(item => item.draft === draft.id)
		: chat.busy && (!draft.turn || chat.turn?.id === draft.turn);
	if (alive) return draft;
	chat.draft = undefined;
}

export type TaskDraftResult =
	| {
		ok: true;
		draft: TaskDraft;
		/** As of the reply: a turn can finish before its request is answered. */
		state: "queued" | "running" | "ended";
		existing: boolean;
	}
	| { ok: false; reason: string; code?: "planner-not-attached" };

/**
 * Ask the Planner for implementation tasks without a member message.
 *
 * Like an accepted comment, this is an instruction rather than something said:
 * the transcript gets a system line saying who asked, and the instruction goes
 * to the model alone. One draft per document is live, whatever revision it was
 * asked for, since its instruction reads the latest document; asking again
 * returns it, so collaborators opening Build together start one turn. It takes
 * the same place in line, and the same limits, as a Chat message.
 */
export async function draftTasks(
	context: Room,
	handle: string,
	planRevision: number,
	text: string,
	said: string,
	user = handle,
): Promise<TaskDraftResult> {
	let { chat } = context;
	if (chat.pendingSends >= MAX_PENDING_SENDS && !await awayOrNot(context)) {
		return { ok: false, reason: "the reply queue is full" };
	}
	chat.pendingSends++;
	let post = () => postDraft(context, handle, planRevision, text, said, user);
	let accepted = chat.sending.then(post, post);
	let completed = accepted.finally(() => chat.pendingSends--);
	chat.sending = completed.then(() => {}, () => {});
	return completed;
}

async function postDraft(
	context: Room,
	handle: string,
	planRevision: number,
	text: string,
	said: string,
	user: string,
): Promise<TaskDraftResult> {
	let { chat, config, room, server } = context;
	if (!config.agent) return { ok: false, reason: "Chopin is not running" };
	if (chat.closed) return { ok: false, reason: "chat is closed" };
	// Without rows, under HARNESS=remote, a draft queued with no Planner attached would never run;
	// with them it waits for one.
	let waitsAway = false;
	if (context.deferred) {
		waitsAway = await away(context);
	} else {
		let unattached = await context.plannerNotAttached?.();
		if (unattached) return { ok: false, reason: unattached, code: "planner-not-attached" };
	}
	let existing = liveDraft(chat);
	if (existing) return { ok: true, draft: existing, state: existing.state, existing: true };
	// The draft waits in the queue even when the Planner is idle, so it counts against it.
	if (full(chat, waitsAway)) return { ok: false, reason: "the reply queue is full" };
	let draft: TaskDraft = { id: ulid(), planRevision, state: "queued" };
	chat.draft = draft;
	let turn = context.deferred
		? newTurn({
			documentId: room,
			kind: "draft",
			request: draft.id,
			handle,
			userId: user,
			text,
			planRevision,
			claimant: context.claimantSessionId,
			owner: chat.owner?.sessionId,
		})
		: undefined;
	let waiting: Waiting = {
		id: draft.id,
		handle,
		text,
		draft: draft.id,
		sessionId: context.claimantSessionId,
		...(turn ? { deferred: mark(turn) } : {}),
	};
	// Held in the queue while the notice saves, so the draft stays live throughout.
	chat.waiting.push(waiting);
	let abandon = (reason: string): TaskDraftResult => {
		chat.waiting = chat.waiting.filter(item => item !== waiting);
		if (chat.draft === draft) chat.draft = undefined;
		return { ok: false, reason };
	};
	try {
		if (turn) await postNotice(context, said, undefined, ulid(), [insert(turn)]);
		else await instructionNotice(context, said);
	} catch {
		return abandon("could not save the request");
	}
	if (chat.closed) return abandon("chat is closed");
	let answer = (): TaskDraftResult => ({
		ok: true,
		draft,
		state: liveDraft(chat) === draft ? draft.state : "ended",
		existing: false,
	});
	// A turn that ended while the notice saved may already have started, or finished, this one.
	if (!chat.waiting.includes(waiting)) return answer();
	if (occupied(chat) || turn) {
		drafting(server, room, draft, "queued");
		if (turn) void kick(context);
		return answer();
	}
	chat.waiting = chat.waiting.filter(item => item !== waiting);
	startRun(
		{ ...context, draft: draft.id },
		handle,
		text,
		undefined,
		context.claimantSessionId,
	);
	return answer();
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
	// A request kept as a row is withdrawn with its row, or it would come back with a restart.
	if (found.deferred) {
		if (found.message) void remove(context, ws, msg as unknown as Request<Wire.Delete>);
		else void cancelRow(context, found, "spent");
		return;
	}
	chat.waiting = chat.waiting.filter(item => item.id !== msg.id);
	queued(chat, server, room);
	void report(found, { status: "skipped" });
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
	chat.initiative?.cancel();
	let session = chat.retained?.session ?? chat.agent;
	let runs = session?.runs?.();
	let live = (runs?.active.length ?? 0) > 0;
	let notice = (paused: boolean, outcome?: "held" | "unconfirmed" | "failed") =>
		say(chat, server, room, {
			id: ulid(),
			author: { kind: "system" },
			text: paused
				? `@${ws.data.handle} stopped Chopin and paused its workflows.`
				: outcome === "held"
				? `@${ws.data.handle} asked Chopin to stop. Its machine is disconnected, `
					+ "so its workflows will pause when it reconnects."
				: outcome === "unconfirmed"
				? `@${ws.data.handle} asked Chopin to stop its workflows. It has not confirmed `
					+ "yet, and if its machine is disconnected they will pause when it reconnects."
				: outcome === "failed" && !turn
				? `@${ws.data.handle} asked Chopin to stop, but its workflows could not be paused.`
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
	if (!turn && !live) {
		// A Planner that only waits on a question it asked has nothing to pause; Stop withdraws it.
		// One whose workflows are paused keeps them and their question for Resume.
		if (chat.retained && chat.retained.session.inputs?.open() && !runs?.paused.length) {
			await chat.retained.release();
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: `@${ws.data.handle} stopped Chopin and withdrew its open question.`,
				ts: now(),
			});
		}
		return;
	}
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
			let outcome: "held" | "unconfirmed" | "failed" | undefined;
			try {
				// A Planner whose link is down, or dropped before it answered, hears the Stop when it
				// returns, not now; one that has not answered yet may or may not have heard it.
				let result = await pauseRuns.call(session);
				if (result) outcome = result;
				else stopping.paused = true;
			} catch (err) {
				console.error("[chat] pausing workflow runs failed:", err);
				outcome = "failed";
			}
			notice(stopping.paused, outcome);
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
	let text = `@${ws.data.handle} resumed Chopin's workflows.`;
	try {
		await session.resumeRuns();
	} catch (err) {
		console.error("[chat] resuming workflow runs failed:", err);
		text = "Chopin's workflows could not be resumed.";
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
		// A Planner whose link is down, or dropped before it answered, hears a pause when it
		// returns, not now.
		let outcome = await control(run.id);
		if (outcome === "held") {
			text = `@${ws.data.handle} asked to pause ${run.name}. `
				+ "It will pause when the machine reconnects.";
		} else if (outcome === "unconfirmed") {
			text = `@${ws.data.handle} asked to pause ${run.name}. Chopin has not confirmed `
				+ "yet, and if its machine is disconnected it will pause when it reconnects.";
		}
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

/** Ended runs the Planner is asked to follow up on when they end between its turns. */
const NEEDS_FOLLOW_UP: Partial<Record<Wire.Run["status"], true>> = { blocked: true, failed: true };

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
	let { disconnected: _, ...rest } = run;
	return { ...rest, status: "stopped", ended: run.ended ?? at, waiting: 0 };
}

const LIVE_STATUS = new Set<Wire.Run["status"]>(["running", "waiting", "paused"]);

/**
 * A live card of a session whose Planner is disconnected says so, keeping the status it last
 * reported: the run goes on when the Planner returns. Any other card carries no such mark.
 */
function disconnected(run: Wire.Run, down: boolean): Wire.Run {
	let { disconnected: _, ...rest } = run;
	return down && LIVE_STATUS.has(run.status) ? { ...rest, disconnected: true } : rest;
}

/**
 * What became of the workflow runs a hold rebuilt after a restart kept for its client, whose
 * cards Chat restored live: the client did not come back in time and the cards say its Planner is
 * disconnected (`down`), it came back and took them (`up`), or they ended with the hold. A live
 * session of the room's own reports its runs itself, so none of this applies while one is open.
 */
export async function restoredRuns(
	context: Pick<Room, "chat" | "room" | "server" | "persist">,
	outcome: "down" | "up" | "ended",
): Promise<void> {
	let { chat, room, server } = context;
	if (!chat.runs?.length || chat.retained || chat.closed) return;
	let at = now();
	let next = chat.runs.map(run =>
		outcome === "ended"
			? ENDED_RUN[run.status] ? run : stopped(run, at)
			: disconnected(run, outcome === "down")
	);
	if (JSON.stringify(next) === JSON.stringify(chat.runs)) return;
	await context.persist(() => ({ entries: chat.entries, runs: next }));
	chat.runs = next;
	state(chat, server, room);
}

/** Run cards restored with the document; no session survives a reload of the room, so live ones were stopped. */
export function restoreRuns(runs: Wire.Run[] | undefined): Wire.Run[] | undefined {
	return runs?.length ? mergeRuns(runs, undefined, now()) : undefined;
}

/** The latest stages a run card carries; every stage is stored, and Chat pages in the rest. */
const CARD_STAGES = 12;

/** What storage holds for each run reported to this chat: stage ids in order, and each as JSON. */
const storedStages = new WeakMap<Chat, Map<string, { ids: string[]; json: Map<string, string> }>>();

/**
 * Stores every stage of the reported cards before their window is shown, once a run has more
 * than its card carries. A report that only adds and changes stages writes those; one that drops
 * or reorders stages replaces the run's.
 */
function storeStages(context: Room, cards: Wire.Run[]): Promise<void> | undefined {
	let known = storedStages.get(context.chat)
		?? new Map<string, { ids: string[]; json: Map<string, string> }>();
	storedStages.set(context.chat, known);
	let writes: Array<
		{ card: Wire.Run; ids: string[]; json: Map<string, string>; put: PutRunStages }
	> = [];
	for (let card of cards) {
		let before = known.get(card.id);
		// The card itself keeps a run that has never outgrown it.
		if (!before && card.stages.length <= CARD_STAGES && !card.earlierStages) continue;
		let ids = card.stages.map(stage => stage.id);
		let json = new Map(card.stages.map(stage => [stage.id, JSON.stringify(stage)]));
		let appends = before !== undefined && before.ids.length <= ids.length
			&& before.ids.every((id, index) => ids[index] === id) && json.size === ids.length;
		let stages = appends
			? card.stages.filter(stage => before!.json.get(stage.id) !== json.get(stage.id))
			: card.stages;
		if (appends && !stages.length) continue;
		let put = {
			channelId: context.room,
			runId: card.id,
			stages,
			...(appends ? {} : { replace: true }),
		};
		writes.push({ card, ids, json, put });
	}
	// Nothing to write leaves publication on the same tick.
	if (!writes.length) return undefined;
	return (async () => {
		for (let { card, ids, json, put } of writes) {
			await context.auth.storage.runStages.put(put);
			known.set(card.id, { ids, json });
		}
	})();
}

/** A card as Chat shows it: its latest stages, settled against every earlier one, and a count of the rest. */
function cardWindow(run: Wire.Run): Wire.Run {
	if (run.stages.length <= CARD_STAGES) return run;
	let earlier = run.stages.length - CARD_STAGES;
	return {
		...run,
		stages: settledStages(run.stages).slice(earlier),
		earlierStages: earlier + (run.earlierStages ?? 0),
	};
}

/** Forgets the stored stages of runs Chat no longer shows. */
async function forgetStages(context: Room, shown: Wire.Run[] | undefined): Promise<void> {
	let ids = (shown ?? []).map(run => run.id);
	let known = storedStages.get(context.chat);
	for (let id of known?.keys() ?? []) if (!ids.includes(id)) known!.delete(id);
	try {
		await context.auth.storage.runStages.retain(context.room, ids);
	} catch (err) {
		console.error("[chat] forgetting workflow run stages failed:", err);
	}
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
	followUp = false,
): Promise<void> {
	let known = owners.get(context.chat) ?? new Map<string, PlannerSession>();
	owners.set(context.chat, known);
	for (let run of runs?.cards ?? []) known.set(run.id, session);
	let turn = (publishing.get(context.chat) ?? Promise.resolve()).then(() =>
		publishReport(context, session, runs, releasing, followUp)
	);
	publishing.set(context.chat, turn);
	return turn;
}

async function publishReport(
	context: Room,
	session: PlannerSession,
	runs: Runs | undefined,
	releasing: boolean,
	followUp: boolean,
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
	// A card with no stages for a run Chat already shows stages of changes only the card's status
	// and times: a reattached Planner reports an ended run without them, and they stay stored.
	let kept = new Set<string>();
	let incoming = runs?.cards?.map(reported => {
		// A run has finished only once its root ended, which a finished card carries as `ended`;
		// one reported finished without it has just started and is still live.
		let card: Wire.Run = reported.status === "finished" && reported.ended === undefined
			? { ...reported, status: reported.waiting > 0 ? "waiting" : "running" }
			: reported;
		let shown = card.stages.length ? undefined : prior.find(run => run.id === card.id);
		if (!shown || (!shown.stages.length && !shown.earlierStages)) return card;
		kept.add(card.id);
		let { earlierStages: _, ...fields } = card;
		return {
			...fields,
			stages: shown.stages,
			...(shown.earlierStages ? { earlierStages: shown.earlierStages } : {}),
		};
	});
	let down = !releasing && session.suspended?.() === true;
	let own = mergeRuns(mine, incoming, at).map(run =>
		disconnected(run, down && known.get(run.id) === session)
	);
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
	let attention: Array<{ run: Wire.Run; said: string }> = [];
	for (let run of [...cards, ...replaced]) {
		let ended = ENDED_RUN[run.status];
		let previous = before.get(run.id);
		if (!ended || (previous && ENDED_RUN[previous])) continue;
		let said = `${run.name} ${ended} after ${
			runDuration((run.ended ?? run.updated) - run.started)
		}.`;
		if (followUp && !releasing && NEEDS_FOLLOW_UP[run.status] && known.get(run.id) === session) {
			attention.push({ run, said });
			continue;
		}
		finished.push({ id: ulid(), author: { kind: "system" }, text: said, ts: now() });
	}
	let next = cards.length ? cards.map(cardWindow) : undefined;
	try {
		let storing = storeStages(context, (runs?.cards ?? []).filter(card => !kept.has(card.id)));
		if (storing) await storing;
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
	if (prior.some(run => !shown.has(run.id))) await forgetStages(context, next);
	for (let { run, said } of attention) await followUpEndedRun(context, run, said);
}

/**
 * Start a Planner turn about a run that ended blocked or failed while the
 * Planner was idle. Atomic's own notice would start a turn nobody sees, so the
 * adapter stops that one and this turn, recorded like any other, takes its place.
 */
function followUpEndedRun(context: Room, run: Wire.Run, said: string): Promise<void> {
	let text = `The workflow run ${run.name} (${run.id}) ${ENDED_RUN[run.status]}. `
		+ "Check its status with the workflow tool, then tell the team what happened and what, if anything, they need to do.";
	return Promise.resolve(instruct(context, "chopin", text, said)).catch(err =>
		console.error("[chat] could not follow up on an ended workflow run:", err)
	);
}

/**
 * Whether a question this session asked is still open, or an answer to one has
 * not yet reached the client that asked it: letting the session go before then
 * would turn the answer into a cancellation.
 */
function owesInput(session: PlannerSession): boolean {
	let inputs = session.inputs;
	return !!inputs && (inputs.open() > 0 || inputs.held() > 0);
}

/**
 * Keep a Planner session that still owns workflow runs, or waits on a question
 * it asked, instead of destroying it with its turn: the runs and the question
 * belong to the session, and the next turn reuses it so the Planner can still
 * see and steer them. It is let go once every run has finished, no question
 * is open and every answer has reached its client, when its owner binding
 * ends, or when the chat closes.
 */
function retain(
	context: Room,
	opened: { session: PlannerSession; binding: ActiveOwnerBinding },
): boolean {
	let { chat } = context;
	let runs = opened.session.runs?.();
	let live = !!runs && (runs.active.length > 0 || runs.paused.length > 0);
	// A question no member has answered is open work: its request ends with the session. So does
	// an answer its client has not received.
	let asking = owesInput(opened.session);
	if (chat.retained && chat.retained.session !== opened.session) return false;
	if (opened.binding.signal.aborted) return false;
	if (!live && !asking) {
		if (runs) void publishRuns(context, opened.session, runs);
		return false;
	}
	let report = (next: NonNullable<typeof runs>) => publishRuns(context, opened.session, next);
	if (!chat.retained) {
		let unhold = context.hold?.();
		let releaseWhenIdle = async () => {
			await publishing.get(chat);
			if (chat.busy) await chat.running;
			if (chat.busy || chat.retained?.session !== opened.session) return;
			let current = opened.session.runs?.();
			if (current && (current.active.length || current.paused.length)) return;
			if (owesInput(opened.session)) return;
			await chat.retained.release();
		};
		let release = () =>
			void releaseWhenIdle().catch(err =>
				console.error("[chat] releasing completed workflow session failed:", err)
			);
		let stopWatching = opened.session.watchRuns?.(next => {
			if (chat.retained?.session !== opened.session) return;
			let planning = chat.busy && !chat.job && chat.agent === opened.session;
			let followUp = !planning && opened.session.followsUpRuns !== false;
			void publishRuns(context, opened.session, next, false, followUp);
			if (next.active.length || next.paused.length) return;
			release();
		});
		let stopInputs = opened.session.inputs?.watch(() => {
			if (chat.retained?.session === opened.session) release();
		});
		let stopLink = opened.session.watchLink?.(() => {
			if (chat.retained?.session !== opened.session) return;
			let current = opened.session.runs?.();
			if (current) void publishRuns(context, opened.session, current);
		});
		let released: Promise<void> | undefined;
		let retained: Retained = {
			...opened,
			ended: () => {},
			release: () =>
				released ??= (async () => {
					if (chat.retained === retained) chat.retained = undefined;
					stopWatching?.();
					stopInputs?.();
					stopLink?.();
					retained.binding.signal.removeEventListener("abort", ended);
					try {
						await opened.session.destroy();
					} finally {
						retained.binding.release();
						unhold?.();
						if (chat.agent === opened.session) {
							chat.agent = undefined;
							if (!chat.busy) chat.owner = undefined;
						}
						await publishing.get(chat);
						// A server going down stopped no run: nothing says so, and the cards stay as stored.
						if (!opened.session.shuttingDown?.()) {
							await publishRuns(context, opened.session, unsaved.get(opened.session), true);
						}
						gone.add(opened.session);
					}
				})(),
		};
		let ended = () => {
			// A Planner whose client is away keeps its work through a renewed credential, however
			// long that is; its session takes the renewed one when it is next used.
			if (opened.session.suspended?.() && credentialRenewed(retained.binding)) return;
			void retained.release();
		};
		retained.ended = ended;
		opened.binding.signal.addEventListener("abort", ended, { once: true });
		chat.retained = retained;
	}
	if (runs) void report(runs);
	return true;
}

function currentMemberRequest(chat: Chat): ActiveMemberRequest | undefined {
	let active = chat.activeRequest;
	if (
		!active || chat.closed || !chat.busy || !chat.turnController
		|| chat.turnController.signal.aborted || chat.lifecycle !== active.lifecycle
		|| chat.turn?.id !== active.turnId || !active.userId
	) return undefined;
	let entry = chat.entries.find(value => value.id === active.entryId);
	if (
		entry?.author.kind !== "member" || entry.author.handle !== active.handle
		|| entry.text !== active.text
	) return undefined;
	return active;
}

function visualRouting(context: Room): boolean {
	if (
		context.visualAdmission || !context.config?.plannerVisuals || !context.decide
		|| context.chat.job
		|| context.config.harness !== "copilot-sdk"
	) return false;
	let request = currentMemberRequest(context.chat);
	return !!request && request.text.length <= 1_000;
}

export function documentRoom(context: Room): DocumentRoom {
	let { chat, plan, room, server } = context;
	return {
		investigations: context.investigations,
		id: room,
		plan,
		server,
		publish: mutation => Service.publish(plan, server, room, mutation, { agent: true }),
		persist: () => Promise.resolve(context.persist()).then(() => {}),
		exclusive: action => Service.exclusive(plan, action),
		anchors: () => Service.anchors(plan, server, room),
		changes: found => Service.changes(plan, server, room, found),
		jobs: context.jobs,
		children: context.children,
		turnSignal: () => chat.turnController?.signal,
		...((!chat.job || chat.job.kind === "decision-followup") && context.visualAdmission && {
			visualAdmission: input => {
				let signals = [input.signal, chat.turnController?.signal].filter(
					(signal): signal is AbortSignal => !!signal,
				);
				return context.visualAdmission!({
					...input,
					signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
				});
			},
		}),
		...(!chat.job && {
			checkReply: (text, signal) =>
				checkPlannerReply(
					text,
					context.decide,
					signal && chat.turnController
						? AbortSignal.any([signal, chat.turnController.signal])
						: signal ?? chat.turnController?.signal ?? new AbortController().signal,
				),
		}),
		currentMemberRequest: () => currentMemberRequest(chat),
		...(!chat.job && {
			uploadImage: async ({ bytes, mimeType }) => {
				if (
					chat.closed || !chat.busy || !chat.turnController || chat.turnController.signal.aborted
				) {
					throw new Error("images can be stored only during a Planner turn");
				}
				let channel = await context.auth.storage.channels.get(room);
				if (!channel) throw new Error("this document is unavailable");
				if (channel.archivedAt) throw new Error("this document is archived");
				// Whoever the turn is for owns the upload; a turn nobody asked for, such as a
				// follow-up, is the Planner owner's.
				let uploadedBy = currentMemberRequest(chat)?.userId;
				if (!uploadedBy) {
					let binding = await context.activeOwner?.();
					if (!binding) throw new Error("this Planner has no owner to store the image for");
					try {
						uploadedBy = (await context.auth.sessions.resolve(binding.ownerSessionId))?.user.id;
					} finally {
						binding.release();
					}
				}
				if (!uploadedBy) throw new Error("this Planner has no owner to store the image for");
				let sha256 = createHash("sha256").update(bytes).digest("hex");
				await context.auth.storage.images.put({
					channelId: room,
					sha256,
					mimeType,
					bytes,
					uploadedBy,
					now: context.auth.clock(),
				});
				return { path: imagePath(sha256, mimeType) };
			},
		}),
		focusedChild: () =>
			!chat.closed && chat.busy && chat.turnController && !chat.turnController.signal.aborted
				? chat.focus?.channelId
				: undefined,
		readinessInvestigationRequest: async () => {
			let eligible = () =>
				chat.readiness || context.draft && chat.draft?.id === context.draft
					&& chat.draft.state === "running" && chat.draft.turn === chat.turn?.id;
			if (
				!eligible() || chat.closed || !chat.busy || !chat.turnController
				|| chat.turnController.signal.aborted || !chat.turn
			) return;
			let turn = chat.turn.id;
			let binding = await context.activeOwner?.();
			if (!binding) return;
			try {
				let owner = await context.auth.sessions.resolve(binding.ownerSessionId);
				if (
					!owner || !eligible() || chat.turn?.id !== turn
					|| !chat.turnController || chat.turnController.signal.aborted
				) return;
				return { userId: owner.user.id, entryId: `readiness:${turn}` };
			} finally {
				binding.release();
			}
		},
		...(visualRouting(context) && {
			visual: {
				ask: (request: JevRequest) =>
					context.decide!(request, { signal: chat.turnController?.signal }),
			},
		}),
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
	// A message the Planner has not been given, or never will be, is not part of what it was told.
	let candidates = chat.entries.slice(start)
		.filter(entry =>
			entry.id !== currentEntryId && entry.deliveryState !== "sent"
			&& entry.deliveryState !== "failed"
		)
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

/** Readiness is a scheduling hint; the turn and live tools still revalidate ownership. */
export async function jobReady(
	context: Room,
	claimantSessionId: string | undefined,
	job?: Pick<Job, "kind">,
): Promise<boolean> {
	if (!context.config.agent || context.chat.closed || Service.implementationActive(context.plan)) {
		return false;
	}
	if (
		job?.kind === "decision-followup" && context.chat.busy
		&& full(context.chat)
	) return false;
	if (await context.plannerNotAttached?.()) return false;
	try {
		await resolveOwner(
			context.auth,
			context.repository,
			context.room,
			context.plannerNotAttached ? undefined : claimantSessionId,
		);
		return true;
	} catch {
		return false;
	}
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
		if (await rebindRetained(context, retained) && await retained.binding.revalidate()) {
			context.chat.agent = retained.session;
			return { session: retained.session, binding: retained.binding };
		}
		await retained.release();
	}
	let { ownership, owner, repository } = await resolveOwner(
		context.auth,
		context.repository,
		context.room,
		context.plannerNotAttached ? undefined : claimantSessionId,
	);
	if (context.ownerAvailable && context.chat.job?.kind !== "decision-followup") {
		void context.ownerAvailable().catch(() => {});
	}
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
		) throw new PlannerOwnerUnavailableError("Chopin's owner changed while opening. Try again.");
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
			instructions: workspace =>
				plannerInstructions(
					`${repository.owner}/${repository.name}`,
					bootstrap,
					workspace,
					visualRouting(context),
				),
			model: context.config.model || undefined,
			harness: context.config.harness,
		});
		if (!result.ok) {
			if (binding.signal.aborted) {
				throw new PlannerOwnerUnavailableError("Chopin's owner is unavailable");
			}
			throw new Error(`Chopin's session is unavailable (${result.error.kind})`);
		}
		opened = result.value;
		if (
			chat.lifecycle !== lifecycle || chat.openingOwner !== openingOwner
			|| binding.signal.aborted || !await binding.revalidate()
		) {
			throw new PlannerOwnerUnavailableError(
				"Chopin's session changed while opening. Try again.",
			);
		}
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

/** The login that may claim Planner ownership for the room; none where only an attachment may. */
function claimant(context: Room): string | undefined {
	return context.plannerNotAttached ? undefined : context.claimantSessionId;
}

class PlannerOwnerUnavailableError extends Error {}

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
		throw new PlannerOwnerUnavailableError("This channel's Copilot owner is unavailable.");
	}
	let owner = await auth.sessions.resolve(ownerSessionId);
	if (!owner) {
		throw new PlannerOwnerUnavailableError(
			"The Copilot owner must sign in again or reset this channel's agent.",
		);
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
	) {
		throw new PlannerOwnerUnavailableError(
			"The Copilot owner no longer has repository write access.",
		);
	}
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
	about: Instruction | undefined,
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
	let thread = about?.thread;
	// Where this turn's own messages begin, so its last word can be found again.
	let firstEntry = chat.entries.length;
	let failed = false;
	let replyOnly = false;
	// The turn a failure notice names, kept past `finally`, which clears the live fields.
	let began: { request?: string; focus?: string } = {};

	if (!reserved) {
		chat.busy = true;
		chat.turn = begin(handle, chat.entries.length);
		chat.acting = thread;
		chat.actingChannel = about?.threadChannel;
		(jobTurn ? jobState : state)(chat, server, room);
	} else {
		chat.acting = thread;
		chat.actingChannel = about?.threadChannel;
	}
	try {
		about?.started?.();
	} catch (err) {
		console.error("[chat] an instruction's start could not be recorded:", err);
	}
	// Read directly: the drain has already taken this draft's queue entry.
	let draft = context.draft && chat.draft?.id === context.draft ? chat.draft : undefined;
	if (draft) {
		draft.state = "running";
		draft.turn = chat.turn?.id;
		drafting(server, room, draft, "running");
	}

	chat.readiness = about?.readiness;
	chat.focus = about?.focus ?? member?.focus;
	began = {
		request: member && chat.turn ? member.entryId : undefined,
		focus: chat.focus?.channelId,
	};
	chat.activeRequest = member && chat.turn
		? {
			entryId: member.entryId,
			userId: member.userId,
			handle,
			text,
			claimantSessionId,
			turnId: chat.turn.id,
			lifecycle: chat.lifecycle,
			...(member.focus ? { focus: member.focus } : {}),
		}
		: undefined;
	chat.messageIds = new Map();
	if (!jobTurn) chat.captured = new Set();
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
	let invalidate = () => turnController.abort();
	if (about?.signal?.aborted) invalidate();
	else about?.signal?.addEventListener("abort", invalidate, { once: true });
	chat.turnController = turnController;
	let held = jobTurn ? chat.retained : undefined;
	let heldOwner = chat.owner;
	let heldReferences = held ? new Map(chat.referenceCache) : undefined;
	try {
		// A request kept as a row was handed to its machine in a session opened before its row moved.
		let preopened = (about as Waiting | undefined)?.opened;
		if (about) delete (about as Waiting).opened;
		opened = preopened
			?? await repositorySession(context, claimantSessionId, member?.entryId, references);
		if (about?.signal && about.spent?.()) turnController.abort();
		if (chat.agent !== opened.session || turnController.signal.aborted) {
			throw new Error("Chopin's session changed before the turn started. Try again.");
		}
		chat.jobToolNames = jobTurn
			? new Set(opened.session.activeTools ?? PLANNER_TOOL_NAMES)
			: undefined;
		let prompt: string;
		// The files sent with the message that began the turn, given with the first attempt's prompt.
		let files: PlannerFiles | undefined;
		if (jobTurn) {
			prompt = jobTurn.prompt;
		} else {
			// A skill or a prompt template is Atomic's own `/name args`, which has to open the prompt:
			// what the room said and the focus line wait for the next turn instead of standing before it.
			let command = commandReference(references);
			let opening = command !== undefined && command.commandKind !== COMMAND_KINDS.workflow;
			// Drained rather than copied: what the agent has been told once should
			// not arrive again on the next turn.
			let backscroll = opening ? [] : chat.backscroll;
			if (!opening) chat.backscroll = [];
			let promptReferences = [
				...backscroll.flatMap(said => said.references ?? []),
				...references,
			];
			retainReferences(chat, promptReferences);
			let available = promptReferences.filter(reference => chat.referenceCache.has(reference.id));
			prompt = compose(backscroll, handle, text, references, available, !!context.invokedBy);
			let focus = chat.focus;
			if (focus && !opening) prompt = `${focusContext(focus)}\n\n${prompt}`;
			if (member && chat.entries.find(value => value.id === member.entryId)?.attachments?.length) {
				let sent = await context.auth.storage.chatAttachments.forEntry(room, member.entryId);
				if (sent.length) {
					files = {
						attachments: sent,
						readsImages: !!await context.readsImages?.().catch(() => false),
					};
				}
			}
		}
		if (member) markDelivered(context, member.entryId);
		sendStarted = true;
		if (!jobTurn) {
			chat.toolFinished = (id, output, success) => {
				if (!turnController.signal.aborted) finished(context, id, output, success);
			};
			chat.toolProgress = (id, output) => progressed(context, id, output);
		}
		let signal = AbortSignal.any([opened.binding.signal, turnController.signal]);
		if (jobTurn) releaseJobAbort = watchJobAbort(chat, jobTurn, signal);
		if (jobTurn) {
			let result = await opened.session.stream(prompt, signal);
			for await (let part of result.fullStream) {
				if (turnController.signal.aborted) break;
				translate(context, part);
			}
		} else {
			let existingDecisions = new Set(plan.records.keys());
			let unreadable = false;
			let picked = await context.modelChoice?.().catch((error): { notice: string } => {
				console.error("[chat] could not read the model choice:", error);
				unreadable = true;
				return { notice: UNREADABLE_NOTICE };
			});
			// A choice the harness no longer offers, or that could not be read, falls back to its
			// default: say so, once.
			if (picked?.notice && picked.notice !== chat.modelNotice) {
				say(chat, server, room, {
					id: ulid(),
					author: { kind: "system" },
					text: picked.notice,
					ts: now(),
				});
			}
			chat.modelNotice = picked?.notice;
			// The composers show it too, and are told when it no longer holds.
			if (unreadable !== !!chat.modelUnreadable) {
				chat.modelUnreadable = unreadable;
				broadcast(server, room, { kind: "chat:model-unreadable", ts: 0, unreadable });
			}
			let { notice: _, ...choice } = picked ?? {};
			let session = opened.session;
			await publishPlannerReplies({
				session: {
					stream: (text, abort, _choice, sent) => session.stream(text, abort, choice, sent),
				},
				prompt,
				...(files ? { files } : {}),
				signal,
				decide: context.decide,
				// Only a card still holding its question counts: one a person discarded, or that
				// was cancelled, leaves nothing for the people in the room to decide.
				capturedDecisions: () =>
					[...plan.records.values()].filter(record =>
						!existingDecisions.has(record.id) && record.origin === "planner" && !!record.followUp
						&& holdsQuestion(record.status)
					).length,
				keptDecisions: () =>
					[...plan.records.values()].filter(record =>
						existingDecisions.has(record.id) && chat.captured?.has(record.id)
						&& record.origin === "planner" && !!record.followUp && holdsQuestion(record.status)
					).length,
				publish: part => translate(context, part),
			});
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
		// A stop the room asked for is not a failure; an interruption is.
		failed = !turnController.signal.aborted || !!chat.interruption;
		// A reply the check refused ended no workflow run and answered no question.
		replyOnly = err instanceof PlannerReplyError && !chat.interruption;
		turnController.abort();
		if (jobTurn) {
			outcome = chat.closed
				? { status: "failed", reason: "The document closed." }
				: {
					status: sendStarted || chat.interruption
						? "failed"
						: jobTurn.job.kind === "decision-followup"
								&& err instanceof PlannerOwnerUnavailableError
						? "deferred"
						: "skipped",
					reason: jobReason(err),
				};
		} else if (!chat.closed && failed && !opened?.session.shuttingDown?.()) {
			let suspended = !!opened?.session.suspended?.();
			// Read before `chat.interruption` is cleared below.
			let failure = turnFailureOf({
				error: err,
				interruption: chat.interruption,
				suspended,
				request: chat.activeRequest?.entryId,
				focus: chat.focus?.channelId,
			});
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: suspended
					? "The machine's connection dropped during this reply. Its workflows and open "
						+ "questions are kept; ask again once it has reconnected."
					: failure.kind === "tool"
					? TOOL_UNAVAILABLE
					: err instanceof Error
					? err.message
					: "The agent could not be reached.",
				turnFailure: failure,
				ts: now(),
			});
		}
		chat.interruption = undefined;
	} finally {
		about?.signal?.removeEventListener("abort", invalidate);
		releaseJobAbort?.();
		chat.activeRequest = undefined;
		chat.focus = undefined;
		chat.readiness = undefined;
		chat.turnController = undefined;
		chat.captured = undefined;
		chat.toolFinished = undefined;
		chat.toolProgress = undefined;
		let kept = false;
		try {
			// A turn the Planner's link dropped under fails, but its client may come back for the
			// runs and questions the session still holds.
			if (
				opened && !chat.closed && !jobTurn
				&& (!failed || replyOnly || opened.session.suspended?.())
			) kept = retain(context, opened);
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
							text: "Chopin's session could not close cleanly. Try again.",
							turnFailure: turnFailureOf({ error: err, suspended: false, ...began }),
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
		settle(chat, server, room, turnController.signal.aborted && !failed);
		if (jobTurn) {
			chat.job = undefined;
			chat.jobOutput = undefined;
			chat.jobFailures = undefined;
			chat.jobFailureCode = undefined;
			chat.jobCalls = undefined;
		}
		chat.jobToolNames = undefined;
		// A turn that came from a row ends it in the commit that saves the turn: `interrupted` when
		// the restart cut it off, which is never run again.
		let ending = about?.deferred && context.deferred
			? [move(about.deferred.row, "started", chat.restarted ? "interrupted" : "ended")]
			: undefined;
		chat.restarted = undefined;
		try {
			if (!chat.closed || ending) logRefused(await save(context, ending));
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
		// After the turn's own persistence, so a read prompted by `ended` sees its tasks.
		if (draft) {
			if (chat.draft === draft) chat.draft = undefined;
			drafting(server, room, draft, "ended");
		}
	}

	if (persistenceError) {
		stopAfterPersistenceFailure(chat, server, room);
	}
	if (jobTurn) {
		finishJob(jobTurn, outcome ?? { status: "failed", reason: "The Planner turn ended." });
	}

	// Before the drain, so what it records is in place before the next turn reads anything.
	// A failed save closes the chat, and its owner still needs to hear that the turn failed.
	if (about?.ended && (!chat.closed || persistenceError || about.readiness || about.signal)) {
		// The turn is over: nothing it does can be attributed to the thread any more,
		// and anyone joining before the drain must not read it as still working.
		if (chat.acting === thread && chat.actingChannel === about.threadChannel) {
			chat.acting = undefined;
			chat.actingChannel = undefined;
		}
		let said = chat.entries.slice(firstEntry).findLast(entry => entry.author.kind === "agent");
		let stopped = turnController.signal.aborted && !failed;
		await report(about, {
			status: failed || persistenceError ? "failed" : stopped ? "stopped" : "done",
			...(said?.text.trim() ? { text: said.text } : {}),
		});
	}

	if (chat.closed) return;
	return drain(context, { job: !!jobTurn, outcome });
}

/**
 * Starts the next queued turn, if one may start. Called when a turn has ended (`ended` says how)
 * and, with none running, when something that held the queue is over (`ended` absent).
 */
async function drain(
	context: Room,
	ended?: { job: boolean; outcome: JobOutcome | undefined },
): Promise<void> {
	let { chat } = context;
	if (chat.closed) return;
	// Called with nothing running, another call is already starting the next turn.
	if (!ended && chat.starting) return;
	chat.starting = true;
	try {
		await startNext(context, ended);
	} finally {
		chat.starting = false;
	}
}

async function startNext(
	context: Room,
	ended?: { job: boolean; outcome: JobOutcome | undefined },
): Promise<void> {
	let { chat, room, server } = context;
	// Synchronous unless a request kept as a row has to pass the start rule, so a turn's end and
	// the queue's next step stay in one tick as they always were.
	let take = () => {
		let head = chat.waiting[0];
		if (!head?.deferred || !context.deferred) return pending(chat);
		// A request the machine could not open a session for waits until something new says it may.
		return chat.unopened ? undefined : nextStartable(context);
	};
	let next = startsHeld ? undefined : take();
	if (next instanceof Promise) next = await next;
	while (next) {
		if (next.job) chat.handoffJob = next.job;
		let begun: Begun = "started";
		let turnContext = { ...context, invokedBy: next.invokedBy, draft: next.draft };
		try {
			if (next.deferred && context.deferred) begun = await beginTurn(turnContext, next);
			else await context.persist();
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
			if (next.opened) await discard(context, next.opened);
			return;
		}
		if (begun === "unopened") {
			// Still waiting, still marked sent: back at the head of the queue, as it was.
			chat.unopened = true;
			chat.waiting.unshift(next);
			queued(chat, server, room);
			next = undefined;
			break;
		}
		if (begun === "gone" || next.job?.settled) {
			next = take();
			if (next instanceof Promise) next = await next;
			continue;
		}
		(next.job ? jobQueued : queued)(chat, server, room);
		let nextId = next.id;
		let entry = next.message ? chat.entries.find(item => item.id === nextId) : undefined;
		if (entry && !next.posted) {
			announce(server, room, entry);
			context.memberMessagePersisted?.(entry, next.sessionId);
		}
		let turn = [
			turnContext,
			next.handle,
			next.text,
			next,
			claimantOf(context, next),
			false,
			next.message && next.userId
				? { entryId: next.id, userId: next.userId, ...(next.focus ? { focus: next.focus } : {}) }
				: undefined,
			next.references,
			next.job,
		] as const;
		// The turn marks the Chat busy as it begins, which ends the wait to start.
		chat.starting = false;
		// Called with nothing running, the turn runs on its own, so what called is not held up by it.
		if (ended) await run(...turn);
		else startRun(...turn);
		return;
	}
	// Nothing to start. What the end of a turn wakes may start its own now.
	chat.starting = false;
	// Called with nothing running, there is nothing to settle.
	if (!ended) return;
	chat.busy = false;
	chat.turn = undefined;
	chat.acting = undefined;
	chat.actingChannel = undefined;
	(ended.job ? jobState : state)(chat, server, room);
	// A pre-start availability deferral must wait for a real owner or queue change.
	if (context.ownerAvailable && !chat.closed && ended.outcome?.status !== "deferred") {
		void context.ownerAvailable().catch(() => {});
	}
}

function startRun(
	context: Room,
	handle: string,
	text: string,
	about: Instruction | undefined,
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
		about,
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
	while (next?.spent?.()) {
		void report(next, { status: "skipped" });
		next = chat.waiting.shift();
	}
	if (next?.message && !next.posted) {
		let entry: MemberEntry = {
			id: next.id,
			author: { kind: "member", handle: next.handle },
			text: next.text,
			ts: now(),
			...(next.references?.length ? { references: next.references } : {}),
			...(next.attachments?.length ? { attachments: next.attachments } : {}),
			...(next.delivery ? { delivery: next.delivery } : {}),
		};
		chat.entries.push(entry);
	}
	return next;
}

/** What a start of the queue needs, or that it cannot start now. */
type Gate = { ok: true; claimant?: string } | { ok: false };

/**
 * Whether the queue may start, claiming nothing until a login is known to be live. Under
 * `HARNESS=remote` only an attached Planner starts it. Otherwise the document's owner must have a
 * live login, or, with no owner, a login of one of the waiting requests' senders, which claims it.
 */
async function startGate(context: Room): Promise<Gate> {
	if (context.plannerReady) return await context.plannerReady() ? { ok: true } : { ok: false };
	let { auth, chat, room } = context;
	let owner = (await auth.storage.channels.readAgent(room, auth.clock()))?.agent?.ownerSessionId;
	if (owner) return await auth.sessions.resolve(owner) ? { ok: true } : { ok: false };
	let candidates = new Set(chat.waiting.flatMap(item => item.deferred?.claimants ?? []));
	for (let id of candidates) {
		if (await auth.sessions.resolve(id)) return { ok: true, claimant: id };
	}
	return { ok: false };
}

/** Whether the person who sent a waiting request can still write to the document, if we can tell. */
async function stillWrites(context: Room, item: Waiting): Promise<boolean> {
	let { auth, repository } = context;
	let session = item.sessionId ? await auth.sessions.resolve(item.sessionId) : undefined;
	if (!session) return true;
	try {
		let checked = await auth.sessions.use(
			session,
			token => auth.github.repositoryAccess(token, repository.owner, repository.name),
		);
		let current = checked.value;
		return !!current && current.id === repository.id
			&& (current.permissions.push || current.permissions.admin);
	} catch {
		return true;
	}
}

/** Logs what a commit refused to do to a row; a refused move changes nothing. */
function logRefused(outcomes: DeferredTurnOutcome[] | void): void {
	for (let outcome of outcomes ?? []) {
		if (outcome.action === "transition" && !outcome.changed) {
			console.error(`[chat] a queued request was not moved: ${outcome.reason}`);
		}
	}
}

/**
 * The next queued turn that may start. A request kept as a row starts only through the start
 * rule: a comment whose thread was resolved is cancelled quietly, and one whose sender can no
 * longer write is cancelled as failed. Anything else leaves the queue as it is.
 */
async function nextStartable(context: Room): Promise<Waiting | undefined> {
	let { chat } = context;
	while (true) {
		let first = chat.waiting[0];
		if (!first) return undefined;
		if (!first.deferred || !context.deferred) return pending(chat);
		if (first.spent?.()) {
			chat.waiting.shift();
			await cancelRow(context, first, "spent");
			continue;
		}
		let gate = await startGate(context);
		if (!gate.ok) return undefined;
		if (chat.waiting[0] !== first) continue;
		// A child that was deleted or archived while the request waited would answer in the
		// wrong document, so the request ends instead.
		if (first.focus && context.children && !await context.children.resolve(first.focus.channelId)) {
			if (chat.waiting[0] === first) chat.waiting.shift();
			await cancelRow(context, first, "unavailable");
			continue;
		}
		if (chat.waiting[0] !== first) continue;
		if (!await stillWrites(context, first)) {
			if (chat.waiting[0] === first) chat.waiting.shift();
			await cancelRow(context, first, "access");
			continue;
		}
		if (chat.waiting[0] !== first) continue;
		if (gate.claimant) first.sessionId = gate.claimant;
		return pending(chat);
	}
}

/**
 * Shows a message as delivered once its prompt is on its way to the machine: a session is open
 * there and nothing before the prompt can fail. A request kept as a row is marked in the commit
 * that starts it; one that started at once is marked here.
 */
function markDelivered(context: Room, entryId: string): void {
	let { chat, room, server } = context;
	let entry = chat.entries.find(value => value.id === entryId);
	if (!entry || entry.deliveryState !== "sent") return;
	entry.deliveryState = "delivered";
	announce(server, room, entry);
}

type Begun = "started" | "gone" | "unopened";

/** The login whose Copilot entitlement runs a queued turn. */
function claimantOf(context: Room, next: Waiting): string | undefined {
	if (next.job?.job.kind === "decision-followup") return undefined;
	return next.invokedBy ? next.sessionId : next.sessionId ?? context.claimantSessionId;
}

/** Lets go of a session opened for a turn that will not run in it. */
async function discard(context: Room, opened: NonNullable<Waiting["opened"]>): Promise<void> {
	let { chat } = context;
	// A retained session lives on for its workflow runs; it was only borrowed.
	if (chat.retained?.session === opened.session) return;
	try {
		await opened.session.destroy();
	} catch (err) {
		console.error("[chat] could not close a session no turn used:", err);
	}
	opened.binding.release();
	if (chat.agent === opened.session) chat.agent = undefined;
	chat.owner = undefined;
}

/**
 * Saves that a queued turn is about to run. A request kept as a row is handed to the machine only
 * once a session is open there: it moves from waiting to started in the commit that shows its
 * message as delivered, never before. `unopened` says the machine could not open one, and the row
 * is still waiting; `gone`, that the row is no longer waiting because it was cancelled meanwhile,
 * and the turn must not run.
 */
async function beginTurn(context: Room, next: Waiting): Promise<Begun> {
	let { chat, room, server } = context;
	let held = next.deferred;
	if (!held || !context.deferred) {
		await context.persist();
		return "started";
	}
	let opened: NonNullable<Waiting["opened"]>;
	try {
		opened = await repositorySession(
			context,
			claimantOf(context, next),
			next.message && next.userId ? next.id : undefined,
			next.references,
		);
	} catch (err) {
		console.error("[chat] a saved request waits: no session could be opened for it:", err);
		return "unopened";
	}
	let entry = next.message
		? chat.entries.find(value => value.id === (held.entry ?? next.id))
		: undefined;
	let before = entry?.deliveryState;
	if (entry) entry.deliveryState = "delivered";
	let outcomes: DeferredTurnOutcome[] | void;
	try {
		outcomes = await context.persist(undefined, [move(held.row, "waiting", "started")]);
	} catch (err) {
		if (entry) entry.deliveryState = before;
		await discard(context, opened);
		throw err;
	}
	let outcome = outcomes?.[0];
	if (outcome && outcome.action === "transition" && !outcome.changed) {
		logRefused(outcomes);
		if (entry && before !== undefined) entry.deliveryState = before;
		await discard(context, opened);
		return "gone";
	}
	if (entry) announce(server, room, entry);
	next.opened = opened;
	return "started";
}

/**
 * Starts the queue now if it may start, once whatever else is being accepted has been. A request
 * that can start at once, such as one a machine that is back was waiting for, never waits for the
 * next turn to end.
 */
export function kick(context: Room): Promise<void> {
	let { chat } = context;
	if (!context.deferred || chat.closed) return Promise.resolve();
	// Whatever called says the machine may be there now, so the head of the queue is tried again.
	chat.unopened = false;
	let go = async () => {
		if (chat.closed) return;
		// Before anything starts, so a message whose save was never answered is not passed over.
		if (chat.unsure?.size) {
			await adoptUnsure(context).catch(err =>
				console.error("[chat] could not look for a message whose save was not answered:", err)
			);
		}
		if (chat.busy || chat.starting || startsHeld || chat.waiting.length === 0) return;
		await drain(context);
	};
	let accepted = chat.sending.then(go, go);
	chat.sending = accepted.then(() => {}, () => {});
	return accepted.catch(err => console.error("[chat] could not start the queue:", err));
}

type CancelWhy = "spent" | "agent" | "unavailable" | "access";

const FAILURE: Record<Exclude<CancelWhy, "spent">, Wire.DeliveryFailure> = {
	agent: "machine-removed",
	access: "access-lost",
	unavailable: "document-unavailable",
};

/**
 * Ends a waiting request without running it. A message stays in the transcript marked as one that
 * could not be delivered, and says why; a comment whose thread was resolved needs no word, because
 * the resolution is what its members see; anything else gets a notice and its own mark cleared.
 */
async function cancelRow(context: Room, item: Waiting, why: CancelWhy): Promise<void> {
	let { chat, room, server } = context;
	let held = item.deferred;
	if (!held) return;
	chat.waiting = chat.waiting.filter(value => value !== item);
	let row = { kind: held.kind, handle: item.handle };
	let entry = item.message
		? chat.entries.find(value => value.id === (held.entry ?? item.id))
		: undefined;
	if (entry && why !== "spent") {
		entry.deliveryState = "failed";
		entry.deliveryFailure = FAILURE[why];
	}
	let changes = [move(held.row, "waiting", "cancelled", why === "spent" ? undefined : why)];
	try {
		if (!entry && why !== "spent") {
			logRefused(
				await postNotice(
					context,
					cancelledNotice(row, why === "agent" ? "agent" : why),
					undefined,
					`cancelled:${held.row}`,
					changes,
				),
			);
		} else {
			logRefused(await context.persist(undefined, changes));
		}
	} catch (err) {
		console.error("[chat] could not cancel a queued request:", err);
	}
	if (entry) announce(server, room, entry);
	if (held.kind === "draft" && chat.draft?.id === held.request) {
		drafting(server, room, chat.draft, "ended");
		chat.draft = undefined;
	}
	if (held.kind === "comment" && why !== "spent") {
		context.deferred?.threadEnded?.({ ...held, ...item } as never, "failed");
	}
	queued(chat, server, room);
	void report(item, { status: "skipped" });
}

/** Ends every waiting request, because the agent was reset or the document went away. */
export async function cancelQueued(context: Room, why: "agent" | "unavailable"): Promise<void> {
	let { chat } = context;
	if (!context.deferred) return;
	await load(context);
	for (let item of chat.waiting.slice()) {
		if (item.deferred) await cancelRow(context, item, why);
	}
}

/**
 * Withdraw a message the machine has not taken yet. Only its author may. It leaves the Chat for
 * everyone and is never delivered; its row is cancelled in the commit that removes it.
 */
export function remove(context: Room, ws: Socket, msg: Request<Wire.Delete>): Promise<void> {
	// After every send already admitted, so a delete never overtakes the message it takes back.
	let process = () =>
		removeNow(context, ws, msg).catch(err => {
			// Unanswered, a delete would leave the page waiting on it. Without the code that ends
			// it, it is asked again.
			console.error("[chat] a message could not be deleted:", err);
			fail(ws, msg.rid, "could not delete message");
		});
	let accepted = context.chat.sending.then(process, process);
	context.chat.sending = accepted.then(() => {}, () => {});
	return accepted;
}

async function removeNow(context: Room, ws: Socket, msg: Request<Wire.Delete>): Promise<void> {
	let { chat, room, server } = context;
	let entry = chat.entries.find(value => value.id === msg.id);
	let item = chat.waiting.find(value => value.id === msg.id && value.message && value.deferred);
	if (!entry && context.deferred) {
		// Deleting twice leaves the message deleted, as asking twice would.
		let row = await context.plan.persistence.storage.deferredTurns.get(room, msg.id);
		if (row?.state === "cancelled" && row.handle === ws.data.handle) {
			return reply(ws, msg.rid, { kind: "chat:delete", ts: 0, id: msg.id });
		}
		if (!row) {
			// Nothing here: the send it takes back was lost, or is still on its way on a connection
			// that is gone. It is remembered as taken back, so that it cannot arrive after this.
			chat.retracted ??= new Set();
			chat.retracted.add(msg.id);
			if (chat.retracted.size > MAX_RETRACTED) {
				chat.retracted.delete(chat.retracted.values().next().value!);
			}
			return reply(ws, msg.rid, { kind: "chat:delete", ts: 0, id: msg.id });
		}
		if (row.state === "waiting" && row.kind === "composer" && row.handle === ws.data.handle) {
			// Kept by a send whose answer was a passing trouble (the commit went through and its
			// acknowledgement did not): nothing of it was shown or queued here, so only the row is
			// taken back, and the machine never gets it.
			let queued = chat.waiting.find(value => value.deferred?.row === row.id);
			chat.waiting = chat.waiting.filter(value => value !== queued);
			try {
				logRefused(await context.persist(undefined, [move(row.id, "waiting", "cancelled")]));
			} catch {
				if (queued) chat.waiting.push(queued);
				return fail(ws, msg.rid, "could not delete message");
			}
			forgetFiles(context, msg.id);
			return reply(ws, msg.rid, { kind: "chat:delete", ts: 0, id: msg.id });
		}
	}
	if (
		entry?.author.kind !== "member" || entry.author.handle !== ws.data.handle
		|| entry.deliveryState === "delivered" || entry.deliveryState === undefined
	) return fail(ws, msg.rid, "this message cannot be deleted", "message-not-deletable");
	let index = chat.entries.indexOf(entry);
	let changes: DeferredTurnChange[] = [];
	if (entry.deliveryState === "sent") {
		// Out of the queue first, so a turn that ends now cannot start it.
		// Being taken by the machine right now: if that fails it waits again, so this is not the last
		// word, and the browser asks again until it is delivered or deleted.
		if (!item?.deferred) return fail(ws, msg.rid, "this message is already on its way");
		chat.waiting = chat.waiting.filter(value => value !== item);
		changes.push(move(item.deferred.row, "waiting", "cancelled"));
	}
	chat.entries.splice(index, 1);
	// A running turn's entries sit after the ones before it; taking one of those out moves it up.
	let shifted = !!chat.turn && index < chat.turn.entryOffset;
	if (shifted) chat.turn!.entryOffset--;
	try {
		logRefused(await context.persist(undefined, changes));
	} catch {
		chat.entries.splice(index, 0, entry);
		if (shifted) chat.turn!.entryOffset++;
		if (item) chat.waiting.push(item);
		return fail(ws, msg.rid, "could not delete message");
	}
	reply(ws, msg.rid, { kind: "chat:delete", ts: 0, id: msg.id });
	broadcast(server, room, { kind: "chat:removed", ts: 0, id: msg.id });
	forgetFiles(context, msg.id);
	if (item) void report(item, { status: "skipped" });
}

/** A deleted message's files go with it; a failure here only leaves bytes nobody can reach. */
function forgetFiles(context: Room, entryId: string): void {
	void context.auth.storage.chatAttachments.discardEntry(context.room, entryId).catch(err =>
		console.error("[chat] a deleted message's files were not removed:", err)
	);
}

/** Send a message that could not be delivered again, as it was. Only its author may. */
export async function retry(context: Room, ws: Socket, msg: Request<Wire.Retry>): Promise<void> {
	try {
		await retryNow(context, ws, msg);
	} catch (err) {
		console.error("[chat] a message could not be sent again:", err);
		fail(ws, msg.rid, "could not send message again");
	}
}

async function retryNow(context: Room, ws: Socket, msg: Request<Wire.Retry>): Promise<void> {
	let { chat, room, server } = context;
	let entry = chat.entries.find(value => value.id === msg.id);
	let saved = entry ? (entry as MemberEntry).delivery : undefined;
	if (
		!context.deferred || entry?.author.kind !== "member" || entry.author.handle !== ws.data.handle
		|| entry.deliveryState !== "failed" || !saved
	) return fail(ws, msg.rid, "this message cannot be sent again");
	if (full(chat, await away(context))) {
		return fail(ws, msg.rid, "the queue is full", "planner-queue-full");
	}
	let turn = newTurn({
		documentId: room,
		kind: "composer",
		request: ulid(),
		handle: entry.author.handle,
		userId: ws.data.principalId,
		text: entry.text,
		references: entry.references,
		delivery: { ...saved, entry: entry.id } as unknown as JsonValue,
		claimant: context.claimantSessionId,
		owner: chat.owner?.sessionId,
	});
	let failure = entry.deliveryFailure;
	entry.deliveryState = "sent";
	delete entry.deliveryFailure;
	try {
		await context.persist(undefined, [insert(turn)]);
	} catch {
		entry.deliveryState = "failed";
		entry.deliveryFailure = failure;
		return fail(ws, msg.rid, "could not send message again");
	}
	chat.waiting.push({
		id: entry.id,
		handle: entry.author.handle,
		text: entry.text,
		...(entry.references?.length ? { references: entry.references } : {}),
		delivery: saved,
		message: true,
		posted: true,
		sessionId: context.claimantSessionId,
		userId: ws.data.principalId,
		deferred: mark(turn, entry.id),
	});
	reply(ws, msg.rid, { kind: "chat:retry", ts: 0, id: entry.id });
	announce(server, room, entry);
	void kick(context);
}

/**
 * The waiting item a row stands for once a document opens again; undefined when nothing remains of
 * it. `behind` is the waiting rows accepted after it, which a message kept without its transcript
 * entry is put back ahead of.
 */
async function restoreWaiting(
	context: Room,
	row: DeferredTurn,
	behind: DeferredTurn[] = [],
): Promise<Waiting | undefined> {
	let { chat } = context;
	let focus = row.focusChannelId
		? { channelId: row.focusChannelId, title: row.focusTitle ?? "" }
		: undefined;
	let base = {
		handle: row.handle,
		text: row.text,
		sessionId: row.claimantSessionId,
		...(focus ? { focus } : {}),
	};
	switch (row.kind) {
		case "composer":
		case "invoke_planner": {
			let saved = row.delivery as (Delivery & { entry?: string }) | undefined;
			let entryId = saved?.entry ?? row.requestId;
			let references = row.references as unknown as Wire.Reference[];
			let entry = chat.entries.find(value => value.id === entryId);
			// A message first sent keeps its row and its transcript entry in one commit. Its entry is
			// missing only when that commit's answer was lost and a later save wrote the transcript
			// without it: the row is its sender's message still, and its entry is made again. One sent
			// again by its sender (`entryId` is not its own request) has an entry or has none to make.
			if (!entry && row.kind === "composer" && saved && entryId === row.requestId) {
				let made: MemberEntry = {
					id: row.requestId,
					author: { kind: "member", handle: row.handle },
					text: row.text,
					ts: Math.floor(row.createdAt.getTime() / 1000),
					...(references.length ? { references } : {}),
					delivery: {
						destination: saved.destination,
						requestFingerprint: saved.requestFingerprint,
						canonicalFingerprint: saved.canonicalFingerprint,
					},
					deliveryState: "sent",
				};
				entry = made;
				let ahead = behind.flatMap(value =>
					chat.entries.findIndex(item =>
						item.id
							=== ((value.delivery as { entry?: string } | undefined)?.entry ?? value.requestId)
					)
				).filter(index => index >= 0);
				chat.entries.splice(ahead.length ? Math.min(...ahead) : chat.entries.length, 0, made);
			}
			if (!entry) return undefined;
			return {
				...base,
				id: entry.id,
				...(references.length ? { references } : {}),
				...(row.kind === "composer" && saved
					? {
						delivery: {
							destination: saved.destination,
							requestFingerprint: saved.requestFingerprint,
							canonicalFingerprint: saved.canonicalFingerprint,
						},
					}
					: {}),
				message: true,
				posted: true,
				userId: row.userId,
				...(row.kind === "invoke_planner" ? { invokedBy: row.userId } : {}),
				deferred: mark(row, entry.id),
			};
		}
		case "invoke_system":
			return { ...base, id: row.requestId, quiet: true, deferred: mark(row) };
		case "draft":
			chat.draft = { id: row.requestId, planRevision: row.planRevision ?? 0, state: "queued" };
			return { ...base, id: row.requestId, draft: row.requestId, deferred: mark(row) };
		case "comment": {
			let restored = await context.deferred?.restoreComment?.(row) as Waiting | undefined;
			return restored && {
				...restored,
				id: row.requestId,
				sessionId: row.claimantSessionId,
				deferred: mark(row),
			};
		}
	}
}

/**
 * Puts the document's waiting rows back in its queue, in the order they were accepted, and makes
 * its messages say what became of them: a message still marked sent whose row is gone from the
 * queue was cancelled while the document was closed, or was taken before the mark was saved.
 * Idempotent: a row already in the queue is left alone.
 */
async function load(context: Room): Promise<void> {
	let { chat, plan, room, server } = context;
	let store = plan.persistence.storage.deferredTurns;
	let waiting = await store.list(room, ["waiting"]);
	let known = new Set(chat.entries);
	for (let [index, row] of waiting.entries()) {
		if (chat.waiting.some(item => item.deferred?.row === row.id)) continue;
		let behind = waiting.slice(index + 1);
		let item = await restoreWaiting(context, row, behind);
		if (!item) {
			logRefused(await context.persist(undefined, [move(row.id, "waiting", "cancelled")]));
			continue;
		}
		enqueueRestored(chat, item, behind);
		if (item.draft && chat.draft) drafting(server, room, chat.draft, "queued");
	}
	let made = chat.entries.filter(entry => !known.has(entry));
	let changed = made.length > 0;
	for (let entry of chat.entries) {
		if (entry.deliveryState !== "sent" || chat.waiting.some(item => item.id === entry.id)) continue;
		let row = await store.get(room, entry.id);
		let cancelled = row?.state === "cancelled"
			|| (!row && !waiting.some(value => value.requestId === entry.id));
		entry.deliveryState = cancelled ? "failed" : "delivered";
		// The reason the row was cancelled for; none recorded says nothing rather than a wrong one.
		if (row?.cancelReason) entry.deliveryFailure = FAILURE[row.cancelReason];
		changed = true;
		announce(server, room, entry);
	}
	if (changed) await context.persist();
	for (let entry of made) announce(server, room, entry);
	queued(chat, server, room);
}

/** Puts a restored request in the queue ahead of the ones accepted after it, and of background jobs. */
function enqueueRestored(chat: Chat, item: Waiting, behind: DeferredTurn[]): void {
	let later = new Set(behind.map(row => row.id));
	let at = chat.waiting.findIndex(value => !value.deferred || later.has(value.deferred.row));
	chat.waiting.splice(at < 0 ? chat.waiting.length : at, 0, item);
}

/**
 * Puts back a message that its commit kept though the answer to it was lost: in the queue ahead of
 * what was accepted after it, in the transcript where it was, and saved there, so a restart finds
 * it too. Throws, leaving it for the next attempt, when it could not be saved.
 */
async function adopt(context: Room, row: DeferredTurn): Promise<void> {
	let { chat, plan, room, server } = context;
	if (chat.waiting.some(item => item.deferred?.row === row.id)) return;
	let waiting = await plan.persistence.storage.deferredTurns.list(room, ["waiting"]);
	let behind = waiting.slice(waiting.findIndex(value => value.id === row.id) + 1);
	let known = new Set(chat.entries);
	let item = await restoreWaiting(context, row, behind);
	if (!item) return;
	enqueueRestored(chat, item, behind);
	let made = chat.entries.filter(entry => !known.has(entry));
	try {
		await context.persist();
	} catch (error) {
		chat.waiting = chat.waiting.filter(value => value !== item);
		chat.entries = chat.entries.filter(entry => !made.includes(entry));
		throw error;
	}
	for (let entry of made) {
		announce(server, room, entry);
		context.memberMessagePersisted?.(entry, row.claimantSessionId);
	}
	queued(chat, server, room);
}

/** Looks for the messages whose save was not answered among the rows, and puts back the ones kept. */
async function adoptUnsure(context: Room): Promise<void> {
	let { chat, plan, room } = context;
	for (let id of chat.unsure ?? []) {
		let row = await plan.persistence.storage.deferredTurns.get(room, id);
		if (row?.state === "waiting") await adopt(context, row);
		chat.unsure!.delete(id);
	}
}

const recovered = new WeakSet<Chat>();

/**
 * Brings back what a restart left: requests a turn had started when the process stopped are
 * marked interrupted, with a notice and never run again, and the ones still waiting rejoin the
 * queue. Then the queue starts if it may.
 */
export async function recover(context: Room): Promise<void> {
	let { chat, plan, room, server } = context;
	if (!context.deferred || context.rootChannelId || chat.closed) return;
	if (!recovered.has(chat)) {
		recovered.add(chat);
		try {
			let stale = await plan.persistence.storage.deferredTurns.interruptStale(
				plan.persistence.lease(),
				new Date(),
				room,
			);
			for (let row of stale) {
				try {
					await noticeOnce(context, `interrupted:${row.id}`, interruptedNotice(row));
				} catch (err) {
					console.error("[chat] could not say that a restart stopped a request:", err);
				}
				if (row.kind === "comment") context.deferred.threadEnded?.(row, "failed");
				if (row.kind === "draft") {
					broadcast(server, room, {
						kind: "implementation:drafting",
						ts: 0,
						id: row.requestId,
						planRevision: row.planRevision ?? 0,
						state: "ended",
					});
				}
			}
			await load(context);
		} catch (err) {
			recovered.delete(chat);
			throw err;
		}
	}
	await kick(context);
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
			if (part.text.trim() && !entry?.text.trim()) chat.initiative?.replied();
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
			chat.interruption = "Chopin's tool approval was denied.";
			chat.turnController?.abort();
			return;
		case "error": {
			chat.tooling = undefined;
			let reported = part.error instanceof Error ? part.error : new Error(String(part.error));
			let failure = turnFailureOf({
				error: reported,
				suspended: false,
				request: chat.activeRequest?.entryId,
				focus: chat.focus?.channelId,
			});
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: failure.kind === "tool" ? TOOL_UNAVAILABLE : reported.message,
				turnFailure: failure,
				ts: now(),
			});
			return;
		}
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
	let failure = status === "failed" && !refused && name !== "read_reference"
		? toolError(output)
		: undefined;
	let detail = name === "read_reference"
		? success
			? "Reference content was returned privately to Chopin."
			: "The reference could not be read."
		: failure
		? textOutput(failure.message)
		: outputText(output);
	publish(context, {
		id,
		name,
		status,
		...(refused ? { refused: true as const } : {}),
		...(failure
			? {
				error: {
					code: failure.code,
					...(failure.kind === undefined ? {} : { kind: failure.kind }),
				},
			}
			: {}),
		...(started && status !== "running" ? { took: Date.now() - started } : {}),
		...(detail ? { result: detail } : {}),
	});
}

/**
 * A failed tool's structured error, sent as the envelope or as its JSON text.
 * Only a plain object holding a plain `error` object is an envelope, read from
 * its own enumerable properties: an Error or other class instance at either
 * level shows as the raw result, which never shows its hidden properties.
 * Its code and kind are plain identifiers shown as written, so one that the
 * redactor would change is not recognised and shows as the raw result.
 */
function toolError(output: unknown): ToolError["error"] | undefined {
	if (typeof output === "string") {
		try {
			output = JSON.parse(output);
		} catch {
			return undefined;
		}
	}
	if (!plain(output) || !plain(output.error)) return undefined;
	let error = toolErrorSchema.safeParse({ ...output, error: { ...output.error } }).data?.error;
	if (!error) return undefined;
	let shown = [error.code, error.kind ?? ""];
	return shown.every(text => textOutput(text) === text) ? error : undefined;
}

/** Whether a value is an object literal or a null-prototype object. */
function plain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	let prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Whether the session offers this tool; one it does not offer ends the turn. */
function permitted(context: Room, name: string): boolean {
	let { chat } = context;
	if ((chat.agent?.activeTools ?? PLANNER_TOOL_NAMES).includes(name)) return true;
	console.error(`[chat] boundary failure: inactive tool ${name}`);
	chat.interruption = `Chopin's tool boundary failure: ${name}`;
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
	chat.focus = undefined;
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
	// What was admitted before this finishes first: a message that was being saved is saved and
	// answered, not refused as closed. Whatever arrives once the Chat is closed is refused.
	for (let admitted: Promise<void> | undefined; admitted !== chat.sending;) {
		admitted = chat.sending;
		await admitted;
	}
	chat.closed = true;
	chat.initiative?.close();
	chat.job = undefined;
	chat.jobOutput = undefined;
	chat.lifecycle++;
	chat.activeRequest = undefined;
	chat.focus = undefined;
	for (let waiting of chat.waiting) {
		if (waiting.job) finishJob(waiting.job, { status: "failed", reason: "The document closed." });
		// Whoever is waiting on a dropped turn, such as a child's comment, hears it will not run.
		else if (waiting.ended) void report(waiting, { status: "skipped" });
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
