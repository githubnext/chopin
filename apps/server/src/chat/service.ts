/**
 * Chat.
 *
 * One transcript per room, shared by everyone in it, and one turn at a time.
 * Nothing a person sends is ever held for the next turn. A message to the
 * agent starts a turn when it is idle; while a turn runs it is posted at once
 * and given to that turn, which reads it at its next step; and where the
 * harness cannot take input mid-run, or the machine is away, it is refused
 * and says so. The Chat stays open to a colleague's prompt, but never as a
 * line of messages waiting their turn.
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
import { imagePath, imageSize } from "../images/format";
import { fitImage, headerRefusal, inspectImages, STORE_REFUSAL, toolRowOutput } from "./images";
import type { ToolImage } from "./images";

import { ulid } from "@chopin/dialect";

import { PLANNER_TOOL_NAMES } from "../harness/tool-names";
import type { PlannerFiles, PlannerForkHooks, PlannerSession } from "../harness/session";
import { verifiedCheckout } from "../harness/atomic/checkout";
import { rememberCheckout } from "../harness/atomic/workspace";
import { plannerInstructions } from "../agent/planner";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { DocumentRoom, ResearchWorkspaceRequest } from "../agent/tools";
import type { VisualAdmission } from "../agent/visual-admission";
import type { ChildDocuments } from "./children";
import * as Service from "../plan/service";
import { instruction, PLANNER_NAME } from "@chopin/protocol/address";
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
import { CANNOT_STEER, type Steering, steering } from "./steering";
import { ChatCommandError, ChatMentionError, ChatReferenceError } from "./references";
import { createJobQueue, finishJob, jobReason, type JobTurn, safeProjection } from "./job-queue";
import { translateJob } from "./job-translate";
import { argsText, outputText, textOutput } from "./activity";
import { toolErrorSchema } from "@chopin/agent-link";
import { watchJobAbort } from "./job-fence";
import { JOB_TOOLS } from "../agent/job-scope";
import type { Job, JobOutcome } from "../conversation-plan/jobs";
export type { Announcer, NoticeInput } from "./notices";
export type { MemberEntry };
import { isChannelId } from "../channels/id";
import { holdsQuestion } from "../questions/records";
import { broadcast, fail, PASSING, reply, tell } from "../wire";
import { introduce } from "../people";
import { MAX_MESSAGE_BYTES } from "./limits";
import { actor, alone, contributed } from "./initiative";
import { checkPlannerReply, PlannerReplyError, publishPlannerReplies } from "./reply-policy";
import { withSessionContext } from "./session-context";
import { TOOL_UNAVAILABLE, turnFailureOf } from "./turn-failure";
import { retryTarget } from "./retry";
import { runDuration } from "./run-duration";
import { READER_INSTRUCTIONS } from "./reaction-instructions";
import type { InitiativeSchedule } from "./initiative-schedule";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat as Wire, ConversationPlan, Request } from "@chopin/protocol";
import type { Config } from "../config";
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

/** Beyond this, Chopin's own turns waiting behind a running one are a backlog nobody will read. */
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

/**
 * What the server keeps on an entry and clients never see: how a member's message was delivered,
 * whether the Planner wrote an agent entry in answer to a reaction, and which reading of a
 * reaction already got its answer.
 */
type MemberEntry = Wire.Entry & {
	delivery?: Delivery;
	viaReaction?: true;
	answeredIntents?: string[];
};

/** How long the agent's cursor stays where it finished, after a turn ends. */
const LINGER_MS = 5_000;

/**
 * One of Chopin's own turns waiting for the running turn to end: a background job, or an
 * instruction the server wrote that nobody typed. A person's request is never here: it starts a
 * turn, is given to the one running, or is refused.
 *
 * `spent` is asked, just before the turn would run, whether somebody else has
 * already done the work. It is a function rather than a flag because the answer
 * is only knowable at that moment.
 */
export type Waiting = {
	id: string;
	handle: string;
	text: string;
	signal?: AbortSignal;
	readiness?: boolean;
	spent?: () => boolean;
	/** The comment thread this turn was started to act on, if one was. */
	thread?: string;
	/** Told how the turn went, before the next one starts; see `Instruction`. */
	ended?: Instruction["ended"];
	started?: Instruction["started"];
	/** Login session whose Copilot entitlement owns this turn. */
	sessionId?: string;
	/** A background turn, resolved only after its scope is cleaned up. */
	job?: JobTurn;
	/** The child the turn is about. */
	focus?: Focus;
	/** The images and files sent with this message, which its entry shows once it is in Chat. */
	attachments?: Wire.Attachment[];
	/** The child holding `thread`, when the thread is not in this document. */
	threadChannel?: string;
	/** See `Instruction`. */
	quiet?: boolean;
	reader?: Instruction["reader"];
	authorize?: Instruction["authorize"];
};

/** A request for implementation tasks, live while its turn runs. */
export type TaskDraft = {
	id: string;
	planRevision: number;
	state: "running";
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

/** `retry` runs the message's turn again after it failed: the same message, once in context. */
type MemberRequest = Pick<ActiveMemberRequest, "entryId" | "userId" | "focus"> & { retry?: true };

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
	/** Its notice says why it runs, and its text is for the Planner alone. */
	quiet?: boolean;
	/**
	 * The transcript notice's id, stable across restarts: a turn whose notice Chat already shows
	 * was started before and is not started again.
	 */
	notice?: string;
	/**
	 * Marks an instruction a person asked for: a comment note sent to Chopin, or an automatic
	 * follow-up an MCP caller asked for. While a turn runs it is refused, not held, as a message is
	 * only when the harness can take it mid-run, which an instruction that needs a turn of its own
	 * never can.
	 */
	asked?: true;
	/** Answers a reader's reaction: no tools, no owner claimed, the writers' kept session untouched. */
	reader?: true;
	/** Asked as the turn starts, long after it may have been queued; `false` ends it unrun. */
	authorize?: () => Promise<boolean>;
};

/**
 * A child room's way to its root's Chat, which is the only one.
 *
 * Each call opens the root's room and re-asks storage that the child still
 * belongs to it, so a child that moved, or a root that went away, refuses.
 */
export type RootChat = {
	id: string;
	/** Whether the root's Chat can take the turn now, opening the root's room if needed. */
	admission(): Promise<"running" | "off" | "busy">;
	/** An explicit Planner turn on the root's Chat about a thread in this child. */
	instruct(handle: string, text: string, said: string, about: Instruction): Promise<void>;
	/** Whether the root's Chat is running a turn for this child's thread. */
	working(thread: string): boolean;
};

/** Tell an instruction's owner how it went; their failure is theirs, not the turn's. */
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
 * have started one is not answered, so its browser sends it again to the next process.
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

/**
 * Whether Chopin's own turns waiting behind a running one are a backlog. Background jobs wait
 * beside them and do not count, so one of them never makes another fail.
 */
/** What marks an agent entry written while the turn answering a reaction runs. */
function answeringReaction(chat: Chat): { viaReaction?: true } {
	return chat.reactionTurn !== undefined && chat.reactionTurn === chat.turn?.id
		? { viaReaction: true }
		: {};
}

export function full(chat: Chat): boolean {
	return chat.waiting.filter(item => !item.job).length >= MAX_QUEUE;
}

/** Whether a turn is running, or being started, or none may start. */
function occupied(chat: Chat): boolean {
	return chat.busy || !!chat.starting || startsHeld;
}

/**
 * Cuts off the turn running now because the process is restarting: says so in the Chat, then
 * stops it. It is not run again, because it may already have changed the document.
 */
export function interrupt(chat: Chat, notice: string): void {
	if (!chat.busy || !chat.turnController || chat.turnController.signal.aborted) return;
	chat.interruption = notice;
	chat.turnController.abort();
}

/** Resolves when the turn running now, and the ones it starts after it, have ended. */
export async function settled(chat: Chat): Promise<void> {
	await chat.running?.catch(() => {});
}

/**
 * Whether an instruction a person asked for about a thread can run now, asked before anything is
 * saved so a note is never saved for a turn nobody will start. A turn that is running means it
 * cannot: nothing is held for the next one.
 */
export function admission(context: Pick<Room, "chat" | "config">): "running" | "off" | "busy" {
	let { chat, config } = context;
	if (!config.agent) return "off";
	return occupied(chat) ? "busy" : "running";
}

/** Whether a turn is running for a thread; `channel` names the child holding it, when it is one. */
export function workingFor(chat: Chat | undefined, thread: string, channel?: string): boolean {
	// A closed Chat runs nothing more, whatever its last turn left behind.
	if (!chat || chat.closed) return false;
	return chat.acting === thread && chat.actingChannel === channel;
}

export type TurnImages = {
	work: Promise<void>;
	entry?: string;
	calls: Set<string>;
};

export type Chat = {
	initiative?: InitiativeSchedule<import("./initiative").Source>;
	initiativePaused?: boolean;
	initiativeEnabled?: boolean;
	/** Whether at most one person is in the conversation, as Chat was last told. */
	alone?: boolean;
	readiness?: boolean;
	job?: ConversationPlan.Job;
	jobOutput?: string;
	jobFailures?: number;
	jobFailureCode?: "source-shape";
	jobCalls?: Map<string, string>;
	jobToolNames?: ReadonlySet<string>;
	/** The job taken from the waiting turns while its handoff save is pending. */
	handoffJob?: JobTurn;
	/** The background job whose turn holds the Chat, until the next turn starts or the Chat is idle. */
	backgroundTurn?: JobTurn;
	/** The running job's own tool write, which a preemption lets finish so it is recorded whole. */
	jobWriting?: Promise<unknown>;
	/**
	 * A person's turn that preempted a background job, started as soon as the job's turn has wound
	 * down, ahead of anything waiting.
	 */
	preempting?: Parameters<typeof run>;
	/** How often each job (by kind and target) has given way since it last finished, so it ends. */
	preemptions?: Map<string, number>;
	/** Reads reactions to the Planner's messages and starts the turns that answer them. */
	reactions?: import("./reaction-reply").ReactionResponder;
	/** The id of the running turn when it is answering a reaction. */
	reactionTurn?: string;
	reader?: true;
	entries: Wire.Entry[];
	/** Chopin's own turns waiting for the running one to end; never a person's message. */
	waiting: Waiting[];
	/** Serializes complete member send acceptance, including asynchronous resolution and persistence. */
	sending: Promise<void>;
	/** Work admitted to the send FIFO, including the operation currently resolving. */
	pendingSends: number;
	/**
	 * A waiting turn is being taken and has not begun, which can take a commit. Until it has,
	 * nothing else may start one: two turns would run at once, and the first to end would let a
	 * third in.
	 */
	starting?: boolean;
	/**
	 * How a person's message reaches the Planner turn that is running: set while a turn that can be
	 * talked to runs (never a background job's), and open once its session can take one.
	 */
	steering?: Steering;
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
	turnImages?: TurnImages;
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
	toolEntries?: Map<string, string>;
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
	/** The document's live task draft: the one whose turn is running. */
	draft?: TaskDraft;
	/** Compaction markers recorded for this Chat or thread session. */
	compactions?: Wire.CompactionRecord[];
	/** True while the harness is actively compacting context. */
	compacting?: boolean;
	/** Latest context-window usage reported by the harness. */
	usage?: Wire.ContextUsage;
	/** Model context window size reported by the harness for this session. */
	contextWindow?: number;
	/** For a thread Chat: frozen top-level entries up to and including the root message. */
	forkBootstrap?: Wire.Entry[];
	/** Open thread `Chat` instances owned by this top-level Chat, closed when it closes. */
	childChats?: Map<string, Chat>;
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
			// A message an earlier release kept for a machine reads as an ordinary one: nothing is kept.
			let {
				streaming: _streaming,
				deliveryState: _state,
				deliveryFailure: _failure,
				...rest
			} = entry as Wire.Entry & { deliveryState?: unknown; deliveryFailure?: unknown };
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

function begin(handle: string, entryOffset: number, quiet = false): Wire.Turn {
	let startedAt = Date.now();
	return {
		id: ulid(),
		handle,
		started: Math.floor(startedAt / 1000),
		entryOffset,
		startedAt,
		responded: false,
		...(quiet ? { quiet: true } : {}),
	};
}

/**
 * Says whether what is left of the running turn is for people to watch. A reply's words are all
 * out while its after-answer check runs; a repair step the check starts is work again.
 */
function quieten(chat: Chat, server: Server<SocketData>, room: string, quiet: boolean): void {
	if (!chat.turn || !!chat.turn.quiet === quiet) return;
	if (quiet) chat.turn.quiet = true;
	else delete chat.turn.quiet;
	state(chat, server, room);
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

export function publicEntry(value: Wire.Entry): Wire.Entry {
	let { delivery, viaReaction: _via, answeredIntents: _answered, ...entry } = value as MemberEntry;
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
	if (entries.length === 0) return false;
	let entry = entries[0]!;
	try {
		if (entries.length !== 1) throw new Error("duplicate chat request id");
		validateDelivery(entry);
	} catch {
		fail(ws, msg.rid, "chat request id conflicts with existing state");
		return true;
	}
	let saved = (entry as MemberEntry).delivery;
	// A message to the room that went to the Planner, its sender being alone, is the same message:
	// the fingerprint holds the destination it was sent to.
	let sameDestination = saved?.destination === msg.to
		|| (msg.to === "room" && saved?.destination === "planner");
	if (!saved || !sameDestination || saved.requestFingerprint !== fingerprint) {
		fail(ws, msg.rid, "chat request id was reused with different content");
		return true;
	}
	reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id });
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
		participation: {
			enabled: !!chat.initiativeEnabled,
			paused: false,
			...(chat.initiativeEnabled && chat.alone ? { alone: true } : {}),
		},
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
	 * Under `HARNESS=remote`, why a Planner request cannot go to a machine (none is attached, its
	 * machine is away, or one is still being connected to), or undefined while one is attached.
	 * Planner requests are refused with it before anything is posted, and only an attachment takes
	 * Planner ownership.
	 */
	plannerNotAttached?: () => Promise<string | undefined>;
	/**
	 * Under `HARNESS=remote`, waits a bounded time for a Planner a machine is starting for this
	 * document, before an `@chopin` message or `invoke_planner` is checked for one.
	 */
	plannerStarting?: () => Promise<void>;
	/**
	 * Whether a message sent while a turn runs can reach it: the document's harness takes input
	 * mid-run. Absent, or false, a message sent while a turn runs is refused.
	 */
	steers?: () => boolean;
	activeOwner?: () => Promise<ActiveOwnerBinding | undefined>;
	/** Saves the Chat. */
	persist: (chat?: () => Pick<Chat, "entries" | "runs" | "initiativePaused">) => Promise<void>;
	initiativePresent?: (sessionId: string, actor: string) => boolean;
	initiativeAuthorize?: (sessionId: string, actor: string) => Promise<boolean>;
	/**
	 * Whether this person is still in the room and may still read the document, as of now. Unlike
	 * `initiativeAuthorize` it does not ask for write access, and it grants nothing: it only keeps a
	 * reader's reaction from being answered after the reader has gone or lost access.
	 */
	reactionAuthorize?: (sessionId: string, actor: string) => Promise<boolean>;
	commitRoomMessage?: (entry: Wire.Entry) => Promise<void>;
	roomMessagePublished?: () => void;
	/** Runs only after a new member entry is durably saved and its human turn reserved, or given to the one running. */
	memberMessagePersisted?: (entry: Wire.Entry, claimantSessionId: string | undefined) => void;
	/** Called when automatic participation stops holding a message it might reply to. */
	initiativeSettled?: () => void;
	/**
	 * Who is in the document's conversation now (`people` in `./initiative`), a thread's included.
	 * Absent where nobody is known, which is never alone.
	 */
	people?: () => Set<string>;
	/** Called when who is in the conversation may have changed. */
	peopleChanged?: () => void;
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
	/** Set only on a thread's room: the thread's root message id. */
	threadRoot?: string;
	/** Session-tree and remote fork hooks for top-level Chat and threads. */
	sessionForks?: {
		/** `retry`: the turn runs `currentEntryId` again, and nothing of its failed attempt is kept. */
		prepareTurn: (currentEntryId?: string, retry?: boolean) => {
			fork?: PlannerForkHooks;
			skipBootstrap?: boolean;
			untrackedEntries?: Wire.Entry[];
		};
		finishTurn: (
			requestEntryId: string | undefined,
			turnEntries: Wire.Entry[],
		) => Promise<void> | void;
	};
	/** Called when harness-reported context usage or compactions change. */
	onSessionMetaChanged?: () => Promise<void> | void;
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
 * A room message appears immediately. A message to the Planner is never held: it starts a turn
 * when none is running, is posted and given to the turn that is running when its harness can take
 * input mid-run, and is refused, saying why, when it cannot. The destination, rather than its
 * prose, decides which lifecycle it takes. A person alone in the conversation is talking to the
 * Planner, so their message to the room goes to it, as if it named it, with no wait for silence
 * and no judgment; once a second person is there, it goes to the room again.
 */
export async function send(context: Room, ws: Socket, msg: Request<Wire.Send>): Promise<void> {
	if (context.chat.pendingSends >= MAX_PENDING_SENDS) {
		fail(ws, msg.rid, "too many chat messages are waiting to be processed", PASSING);
		return;
	}
	context.chat.pendingSends++;
	// Decided as it arrives, as automatic participation would have counted the room then.
	let to = msg.to === "room" && alone(context, actor(ws)) ? "planner" as const : msg.to;
	let enqueue = () => {
		// Nothing a send throws says its message is at fault: it is answered as a passing trouble, and
		// the browser sends it again with the same request id.
		let process = () =>
			processSend(context, ws, msg, to).catch(err => {
				console.error("[chat] a send failed before it was kept:", err);
				fail(ws, msg.rid, "could not send message", PASSING);
			});
		let accepted = context.chat.sending.then(process, process);
		let completed = accepted.finally(() => context.chat.pendingSends--);
		context.chat.sending = completed.then(() => {}, () => {});
		return completed;
	};
	// A message to the Planner waits, a bounded time, for one a machine is starting before it is
	// checked for one, so the room's messages never wait with it.
	if (to !== "planner" || !context.plannerStarting) return enqueue();
	return context.plannerStarting().catch(() => {}).then(enqueue);
}

/** Whether a message sent now can be given to the turn that is running. */
function canSteer(context: Room): boolean {
	let { chat } = context;
	return !!chat.steering && !chat.closed && !chat.turnController?.signal.aborted
		&& !!context.steers?.();
}

/** Says in the log why a message was refused while a turn runs, naming the harness that takes none. */
function refusedWhileRunning(context: Room): void {
	console.warn(
		`[chat] refused a message while a turn runs: the ${context.config.harness} harness takes no input while a turn runs`,
	);
}

/**
 * How many runs in a row of one job (its kind and target) a person's message may cut short. The
 * next run is let finish, with the person's turn starting the moment it ends, so a job that keeps
 * meeting messages still completes.
 */
const MAX_PREEMPTIONS = 3;

/** What a job that gave way to a person's turn reports: it goes back to wait, unchanged. */
const PREEMPTED: JobOutcome = { status: "preempted", reason: "A person asked the Planner." };

/**
 * Whether what holds the Chat is a background job, running or being handed the Chat, which a
 * person's message to the Planner goes ahead of. A turn a person started, or one Chopin started
 * for something a person did (a Build, a comment, a follow-up), is never one.
 */
function preemptible(chat: Chat): boolean {
	if (chat.closed || chat.preempting || startsHeld) return false;
	if (chat.starting) return !!chat.handoffJob;
	return chat.busy && !!chat.backgroundTurn;
}

/**
 * Starts a person's turn ahead of the background job holding the Chat. The job's turn is stopped
 * and starts this one as it ends; a job being handed the Chat waits behind it instead. A write the
 * job's own tool has under way finishes first, so it is recorded whole and not made again.
 */
function preempt(context: Room, turn: Parameters<typeof run>): void {
	let { chat } = context;
	if (chat.closed) return;
	// The job ended while the message was saved: nothing is in the way.
	if (!chat.busy && !chat.starting) return startRun(...turn);
	chat.preempting = turn;
	let job = chat.backgroundTurn;
	let controller = chat.turnController;
	if (chat.starting || !job || job.preempted || !controller || controller.signal.aborted) return;
	let key = `${job.job.kind}:${job.job.target}`;
	let preemptions = chat.preemptions ??= new Map();
	let count = preemptions.get(key) ?? 0;
	if (count >= MAX_PREEMPTIONS) return;
	preemptions.set(key, count + 1);
	job.preempted = true;
	void Promise.resolve(chat.jobWriting).catch(() => {}).then(() => controller.abort());
}

/** A message posted to the transcript for the Planner turn that is running to read. */
type Given = {
	entry: string;
	handle: string;
	text: string;
	references?: Wire.Reference[];
	focus?: Focus;
	userId: string;
	/** An MCP caller's instruction, which reaches the model as written. */
	invoked?: boolean;
};

/**
 * Gives a posted message to the Planner turn that is running, to be read at its next step. The
 * session may not be ready for it yet, so this waits for it. When the turn ends first or cannot
 * take it, the message is not lost to a queue: a Planner that is idle by then starts a turn for
 * it, and any other says plainly that it was not read.
 */
async function give(context: Room, message: Given): Promise<void> {
	let { chat } = context;
	let way = chat.steering;
	let session = await way?.ready;
	if (session?.steer && chat.steering === way && !chat.closed) {
		try {
			let references = message.references ?? [];
			retainReferences(chat, references);
			let available = references.filter(reference => chat.referenceCache.has(reference.id));
			let prompt = compose(
				[],
				message.handle,
				message.text,
				references,
				available,
				message.invoked,
			);
			if (message.focus) prompt = `${focusContext(message.focus)}\n\n${prompt}`;
			if (chat.entries.find(value => value.id === message.entry)?.attachments?.length) {
				let sent = await context.auth.storage.chatAttachments.forEntry(context.room, message.entry);
				let parts: string[] = [];
				let images: string[] = [];
				for (let file of sent) {
					if (file.kind === "image") images.push(file.name);
					else {
						parts.push(
							`<file name=${JSON.stringify(file.name)}>\n${
								new TextDecoder().decode(file.bytes)
							}\n</file>`,
						);
					}
				}
				if (images.length) {
					parts.push(`(Sent with this message, shown in Chat: ${images.join(", ")}.)`);
				}
				if (parts.length) prompt = `${prompt}\n\n${parts.join("\n\n")}`;
			}
			await session.steer(prompt);
			return;
		} catch (err) {
			console.error("[chat] a message could not be given to the running turn:", err);
		}
	}
	if (chat.closed) return;
	if (!occupied(chat)) {
		startRun(
			{ ...context, ...(message.invoked ? { invokedBy: message.userId } : {}) },
			message.handle,
			message.text,
			undefined,
			context.claimantSessionId,
			false,
			{
				entryId: message.entry,
				userId: message.userId,
				...(message.focus ? { focus: message.focus } : {}),
			},
			message.references,
		);
		return;
	}
	await postNotice(
		context,
		`${PLANNER_NAME} did not read @${message.handle}'s message. Send it again to ask.`,
		undefined,
		ulid(),
	).catch(err => console.error("[chat] could not say that a message was not read:", err));
}

/**
 * Accept an MCP instruction without waiting for its Planner turn.
 *
 * The caller is attributed on the posted message, and the turn runs under the
 * channel's Planner owner. A checkout matters only to the atomic harness, which
 * verifies it before anything is posted and remembers it for the channel. With a
 * `notice`, an automatic follow-up, Chat shows that notice instead of a message
 * and the text goes to the Planner alone, as for any other instruction. While a turn
 * runs, a message is given to it when its harness takes input mid-run, and an instruction
 * that needs a turn of its own is refused: nothing is held for later.
 */
export async function invoke(
	context: Room,
	user: { id: string; login: string; avatarUrl?: string },
	text: string,
	checkout?: string,
	focus?: Focus,
	/** Called once, when the invoked turn ends or the message has been given to the one running; never when this refuses. */
	settled?: () => void,
	notice?: string,
): Promise<
	| "planner-unavailable"
	| "planner-not-attached"
	| "planner-owner-unavailable"
	| "planner-busy"
	| "checkout-unverified"
	| undefined
> {
	let { chat, server, room } = context;
	if (chat.pendingSends >= MAX_PENDING_SENDS) return "planner-busy";
	chat.pendingSends++;
	let post = async () => {
		if (!context.config.agent || chat.closed || context.rootChannelId) {
			return "planner-unavailable" as const;
		}
		if (await context.plannerNotAttached?.()) return "planner-not-attached" as const;
		let verified: string | undefined;
		if (checkout !== undefined && context.config.harness === "atomic") {
			verified = await verifiedCheckout(context.repository, checkout);
			if (!verified) return "checkout-unverified" as const;
		}
		try {
			await resolveOwner(context.auth, context.repository, room, claimant(context));
		} catch {
			return "planner-owner-unavailable" as const;
		}
		if (chat.closed) return "planner-unavailable" as const;
		// A process that is stopping starts no turn: its caller asks again, of the next one.
		if (startsHeld && !chat.busy && !chat.starting) return "planner-unavailable" as const;
		if (notice !== undefined) {
			// An automatic follow-up needs a turn of its own, which a running one cannot give it.
			if (occupied(chat)) return "planner-busy" as const;
			if (verified) rememberCheckout(room, verified);
			await instruct(context, user.login, text, notice, {
				quiet: true,
				asked: true,
				...(focus ? { focus } : {}),
				...(settled ? { ended: () => settled() } : {}),
			});
			return undefined;
		}
		// A background job gives way to a person's instruction, as to their message.
		let preempts = preemptible(chat);
		let running = !preempts && occupied(chat);
		if (running && !canSteer(context)) {
			refusedWhileRunning(context);
			return "planner-busy" as const;
		}
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
		// The caller has no socket in the room, so nothing else has told it who they are.
		introduce(server, room, { login: user.login, avatarUrl: user.avatarUrl });
		announce(server, room, entry);
		if (running) {
			let given = give(context, {
				entry: entry.id,
				handle: user.login,
				text,
				...(focus ? { focus } : {}),
				userId: user.id,
				invoked: true,
			});
			if (settled) void given.finally(settled).catch(() => {});
		} else {
			let asked: Parameters<typeof run> = [
				{ ...context, invokedBy: user.id },
				user.login,
				text,
				undefined,
				context.claimantSessionId,
				false,
				{ entryId: entry.id, userId: user.id, ...(focus ? { focus } : {}) },
				[],
			];
			if (preempts) preempt(context, asked);
			else startRun(...asked);
			// Started here, or by the job's turn it preempted as that ends, so this promise holds this
			// turn (and the waiting turns it starts).
			let turn = chat.running;
			if (settled) {
				if (turn) void turn.finally(settled).catch(() => {});
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
	// It waits, a bounded time, for a Planner that is starting before it is checked for one, as
	// `@chopin` does.
	if (!context.plannerStarting) return enqueue();
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
): Promise<
	| {
		attachments: Wire.Attachment[];
		bind: () => Promise<{ refusal: string; code?: typeof PASSING } | undefined>;
	}
	| { refusal: string; code?: typeof PASSING }
> {
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
		return {
			attachments: files.map(wireAttachment),
			bind: async () => {
				try {
					let bound = await chatAttachments.bind({
						channelId: context.room,
						userId: ws.data.principalId,
						ids,
						entryId: requestId,
					});
					return bound ? undefined : { refusal: refusalText("gone") };
				} catch (err) {
					console.error("[chat] could not bind a message's files:", err);
					return { refusal: "files are temporarily unavailable", code: PASSING };
				}
			},
		};
	} catch (err) {
		console.error("[chat] could not read a message's files:", err);
		return { refusal: "files are temporarily unavailable", code: PASSING };
	}
}

async function processSend(
	context: Room,
	ws: Socket,
	msg: Request<Wire.Send>,
	to: Wire.Destination = msg.to,
): Promise<void> {
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
	let destination = to;
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
	let bindAttachments:
		| (() => Promise<{ refusal: string; code?: typeof PASSING } | undefined>)
		| undefined;
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
		bindAttachments = accepted.bind;
	}
	if (!text && attached.length === 0) return fail(ws, msg.rid, "message text is empty");
	if (chat.closed) return refuseClosed(ws, msg.rid);
	let savedDelivery = delivery(destination, request, text, references);
	let withAttachments = attached.length ? { attachments: attached } : {};

	if (destination === "room") {
		let bindFailure = await bindAttachments?.();
		if (bindFailure) return fail(ws, msg.rid, bindFailure.refusal, bindFailure.code);
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
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id });
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
		let bindFailure = await bindAttachments?.();
		if (bindFailure) return fail(ws, msg.rid, bindFailure.refusal, bindFailure.code);
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
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entries[0]!.id });
		for (let entry of entries) announce(server, room, entry);
		context.memberMessagePersisted?.(entries[0]!, context.claimantSessionId);
		return;
	}

	// Nothing a person sends is held: with no machine to take it (none attached, or its machine
	// away) the message is refused, saying so.
	let unattached = await context.plannerNotAttached?.();
	if (unattached) return fail(ws, msg.rid, unattached, "planner-not-attached");
	if (chat.closed) return refuseClosed(ws, msg.rid);

	chat.initiative?.cancel();
	if (preemptible(chat)) {
		// A background job gives way: the person's turn starts once the job's turn has wound down.
		let bindFailure = await bindAttachments?.();
		if (bindFailure) return fail(ws, msg.rid, bindFailure.refusal, bindFailure.code);
		let entry: MemberEntry = {
			id: requestId,
			author: { kind: "member", handle },
			text,
			ts: now(),
			...(references?.length ? { references } : {}),
			...withAttachments,
			delivery: savedDelivery,
		};
		chat.entries.push(entry);
		try {
			await context.persist();
		} catch {
			chat.entries = chat.entries.filter(value => value.id !== entry.id);
			return fail(ws, msg.rid, "could not save message", PASSING);
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id });
		if (chat.closed) return;
		announce(server, room, entry);
		preempt(context, [
			context,
			handle,
			text,
			undefined,
			context.claimantSessionId,
			false,
			{ entryId: entry.id, userId: ws.data.principalId, ...(focus ? { focus } : {}) },
			references ?? [],
		]);
		context.memberMessagePersisted?.(entry, context.claimantSessionId);
		return;
	}
	if (chat.busy || chat.starting) {
		if (!canSteer(context)) {
			// A stopping process starts no turn in place of a job, and says nothing: the browser sends
			// the message again to the next one.
			if (startsHeld && chat.backgroundTurn) return refuseClosed(ws, msg.rid);
			// A turn that is only beginning or finishing, or a person's turn about to start in place of
			// a job, has no session to give a message to just now: the browser sends it again in a
			// moment, to a Planner that is then idle or working. A harness that takes no input mid-run
			// never will.
			if (!chat.closed && context.steers?.()) {
				return fail(ws, msg.rid, `${PLANNER_NAME} is between replies`, PASSING);
			}
			refusedWhileRunning(context);
			return fail(ws, msg.rid, CANNOT_STEER, "planner-busy");
		}
		let bindFailure = await bindAttachments?.();
		if (bindFailure) return fail(ws, msg.rid, bindFailure.refusal, bindFailure.code);
		let entry: MemberEntry = {
			id: requestId,
			author: { kind: "member", handle },
			text,
			ts: now(),
			...(references?.length ? { references } : {}),
			...withAttachments,
			delivery: savedDelivery,
		};
		chat.entries.push(entry);
		try {
			await context.persist();
		} catch {
			chat.entries = chat.entries.filter(value => value.id !== entry.id);
			return fail(ws, msg.rid, "could not save message", PASSING);
		}
		reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id });
		if (chat.closed) return;
		announce(server, room, entry);
		context.memberMessagePersisted?.(entry, context.claimantSessionId);
		void give(context, {
			entry: entry.id,
			handle,
			text,
			...(references?.length ? { references } : {}),
			...(focus ? { focus } : {}),
			userId: ws.data.principalId,
		});
		return;
	}
	// A process that is stopping starts no turn, and says nothing: the browser sends the message
	// again to the next one, with the same request id.
	if (startsHeld) return refuseClosed(ws, msg.rid);

	let bindFailure = await bindAttachments?.();
	if (bindFailure) return fail(ws, msg.rid, bindFailure.refusal, bindFailure.code);
	let entry: MemberEntry = {
		id: requestId,
		author: { kind: "member", handle },
		text,
		ts: now(),
		...(references?.length ? { references } : {}),
		...withAttachments,
		delivery: savedDelivery,
	};
	// The turn holds the Chat from here; people are told it is running once the machine has its prompt.
	chat.busy = true;
	chat.turn = begin(handle, chat.entries.length + 1);
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
	reply(ws, msg.rid, { kind: "chat:send", ts: 0, id: entry.id });
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

/**
 * Run a failed Planner turn again for the message that began it: the same message, never a new
 * one. The failed attempt (its failure notice and what the agent wrote during it) leaves the
 * transcript and is saved gone before the room is told, so everyone reads one message and, in
 * time, one reply, and the turn's agent is given the message once and nothing of the attempt.
 * Serialized with sends, so a message and a retry never start two turns.
 */
export async function retry(context: Room, ws: Socket, msg: Request<Wire.Retry>): Promise<void> {
	let { chat } = context;
	let message = (msg as { message?: unknown }).message;
	if (typeof message !== "string" || !message || message.length > 128) {
		return fail(ws, msg.rid, "invalid message id");
	}
	if (context.rootChannelId) {
		return fail(ws, msg.rid, "this document's Chat is on its root document");
	}
	if (chat.pendingSends >= MAX_PENDING_SENDS) {
		return fail(ws, msg.rid, "too many chat messages are waiting to be processed", PASSING);
	}
	chat.pendingSends++;
	let process = () =>
		processRetry(context, ws, msg.rid, message).catch(err => {
			console.error("[chat] a retry failed before its turn started:", err);
			fail(ws, msg.rid, "could not retry the reply", PASSING);
		});
	let enqueue = () => {
		let completed = chat.sending.then(process, process).finally(() => chat.pendingSends--);
		chat.sending = completed.then(() => {}, () => {});
		return completed;
	};
	if (!context.plannerStarting) return enqueue();
	return context.plannerStarting().catch(() => {}).then(enqueue);
}

/**
 * The room's transcript as a Retry reads it. The top-level Chat leaves out what a thread's turn
 * copied into it, which only that thread's Retry runs again.
 */
function ownEntries(context: Room): Wire.Entry[] {
	let entries = context.threadRoot === undefined
		? context.chat.entries.filter(entry => entry.fromThread === undefined)
		: context.chat.entries;
	return entries.map(publicEntry);
}

async function processRetry(
	context: Room,
	ws: Socket,
	rid: string,
	message: string,
): Promise<void> {
	let { chat, room, server } = context;
	if (chat.closed) return refuseClosed(ws, rid);
	if (!context.config.agent) return fail(ws, rid, `${PLANNER_NAME} is not running here`);
	let found = retryTarget(ownEntries(context), message, ws.data.handle);
	if ("refusal" in found) return fail(ws, rid, found.refusal);
	let unattached = await context.plannerNotAttached?.();
	if (unattached) return fail(ws, rid, unattached, "planner-not-attached");
	let focus: Focus | undefined;
	if (found.failure.focus) {
		let child: Awaited<ReturnType<ChildDocuments["resolve"]>>;
		try {
			child = await context.children?.resolve(found.failure.focus);
		} catch (err) {
			console.error("[chat] could not resolve the focused child document:", err);
			return fail(ws, rid, "the open child document is unavailable", PASSING);
		}
		if (!child) return fail(ws, rid, "the open child document is unavailable");
		focus = { channelId: child.id, title: child.title };
	}
	if (chat.closed) return refuseClosed(ws, rid);
	if (chat.busy || chat.starting) return fail(ws, rid, `${PLANNER_NAME} is already replying`);
	// A process that is stopping starts no turn, and says nothing: the browser may ask the next one.
	if (startsHeld) return refuseClosed(ws, rid);
	// Read again: the transcript may have moved on while the machine and the child were checked.
	let target = retryTarget(ownEntries(context), message, ws.data.handle);
	if ("refusal" in target) return fail(ws, rid, target.refusal);
	let { request, removed } = target;
	let gone = new Set(removed);
	let before = chat.entries;
	chat.entries = before.filter(entry => !gone.has(entry.id));
	chat.busy = true;
	chat.turn = begin(request.author.handle, chat.entries.length);
	try {
		await context.persist();
	} catch {
		let added = chat.entries.filter(entry => !before.includes(entry));
		chat.entries = [...before, ...added];
		chat.busy = false;
		chat.turn = undefined;
		state(chat, server, room);
		return fail(ws, rid, "could not retry the reply", PASSING);
	}
	reply(ws, rid, { kind: "chat:retry", ts: 0, message });
	if (chat.closed) return;
	broadcast(server, room, { kind: "chat:removed", ts: 0, ids: removed });
	chat.initiative?.cancel();
	startRun(
		context,
		request.author.handle,
		request.text,
		undefined,
		context.claimantSessionId,
		true,
		{
			entryId: request.id,
			userId: ws.data.principalId,
			...(focus ? { focus } : {}),
			retry: true,
		},
		request.references,
	);
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
	return postNotice(context, text, comment, id);
}

/** Saves a system notice, then shows it. */
function postNotice(
	context: Room,
	text: string,
	comment: Instruction["comment"] | undefined,
	id: string,
): Promise<void> {
	let { chat, room, server } = context;
	let entry: Wire.Entry = {
		id,
		author: { kind: "system" },
		text,
		ts: now(),
		...(comment ? { comment } : {}),
	};
	chat.entries.push(entry);
	return context.persist().then(() => {
		announce(server, room, entry);
	});
}

/**
 * Start a Planner turn from something other than a message.
 *
 * Accepting a comment is an instruction in a way prose is not — the `@chopin` rule
 * exists to separate conversation from instruction, and a button press is
 * already the latter. What it is not is a thing anybody said, so the transcript
 * gets a system entry explaining why the agent started moving; an agent that
 * begins editing for no visible reason is worse than a noisy log.
 *
 * One a person asked for (`about.asked`) is refused while a turn runs. One the server wrote
 * itself, which nobody is waiting on, waits for the turn to end.
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

		if (occupied(chat)) {
			if (full(chat)) {
				say(chat, server, room, {
					id: ulid(),
					author: { kind: "system" },
					text: `${PLANNER_NAME} has too much to do already. Try again when it has caught up.`,
					ts: now(),
				});
				return report(about, { status: "failed" });
			}
			let { comment: _comment, notice: _notice, asked: _asked, ...rest } = about;
			chat.waiting.push({
				id: ulid(),
				handle,
				text,
				...rest,
				sessionId: about.reader ? undefined : context.claimantSessionId,
			});
			return;
		}

		startRun(context, handle, text, about, about.reader ? undefined : context.claimantSessionId);
	};
	if (about.spent?.() || about.signal?.aborted) return report(about, { status: "skipped" });
	// A turn a person asked for cannot wait for the one running: it is refused before it is noticed.
	if (about.asked && occupied(chat)) return report(about, { status: "failed" });
	// Automatic participation replies like any member would, so it announces nothing.
	if (!said) return proceed();
	let announced = instructionNotice(context, said, about.comment, about.notice);
	return announced instanceof Promise ? announced.then(proceed) : proceed();
}

function drafting(
	server: Server<SocketData>,
	room: string,
	draft: TaskDraft,
	state: "running" | "ended",
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
 * The draft that is still running, if one is.
 *
 * A record whose turn has gone without reaching the end of one (a closed room, a failed save)
 * is dropped here rather than tracked down every path that can discard it.
 */
function liveDraft(chat: Chat): TaskDraft | undefined {
	let draft = chat.draft;
	if (!draft) return;
	if (chat.busy && (!draft.turn || chat.turn?.id === draft.turn)) return draft;
	chat.draft = undefined;
}

export type TaskDraftResult =
	| {
		ok: true;
		draft: TaskDraft;
		/** As of the reply: a turn can finish before its request is answered. */
		state: "running" | "ended";
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
 * returns it, so collaborators opening Build together start one turn. It needs a turn
 * of its own, so it is refused while another one runs.
 */
export async function draftTasks(
	context: Room,
	handle: string,
	planRevision: number,
	text: string,
	said: string,
): Promise<TaskDraftResult> {
	let { chat } = context;
	if (chat.pendingSends >= MAX_PENDING_SENDS) {
		return { ok: false, reason: `${PLANNER_NAME} is busy. Try again in a moment.` };
	}
	chat.pendingSends++;
	let post = () => postDraft(context, handle, planRevision, text, said);
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
): Promise<TaskDraftResult> {
	let { chat, config, server, room } = context;
	if (!config.agent) return { ok: false, reason: `${PLANNER_NAME} is not running` };
	if (chat.closed) return { ok: false, reason: "chat is closed" };
	let unattached = await context.plannerNotAttached?.();
	if (unattached) return { ok: false, reason: unattached, code: "planner-not-attached" };
	let existing = liveDraft(chat);
	if (existing) return { ok: true, draft: existing, state: existing.state, existing: true };
	if (occupied(chat)) return { ok: false, reason: BUSY_DRAFT };
	let draft: TaskDraft = { id: ulid(), planRevision, state: "running" };
	chat.draft = draft;
	let abandon = (reason: string): TaskDraftResult => {
		if (chat.draft === draft) chat.draft = undefined;
		return { ok: false, reason };
	};
	// Held as the Chat's busy turn while the notice saves, so no other turn starts meanwhile.
	chat.busy = true;
	chat.turn = begin(handle, chat.entries.length);
	state(chat, server, room);
	try {
		await instructionNotice(context, said);
	} catch {
		chat.busy = false;
		chat.turn = undefined;
		state(chat, server, room);
		return abandon("could not save the request");
	}
	if (chat.closed) return abandon("chat is closed");
	startRun(
		{ ...context, draft: draft.id },
		handle,
		text,
		undefined,
		context.claimantSessionId,
		true,
	);
	return {
		ok: true,
		draft,
		state: liveDraft(chat) === draft ? "running" : "ended",
		existing: false,
	};
}

const BUSY_DRAFT = `${PLANNER_NAME} is working on something else. Try again when it has finished.`;

let jobState = safeProjection(state);
let { job, cancelQueuedJobs, stopAfterPersistenceFailure } = createJobQueue({
	state: jobState,
	startRun,
	MAX_QUEUE,
});
export { cancelQueuedJobs, job };

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
				? `@${ws.data.handle} stopped ${PLANNER_NAME} and paused its workflows.`
				: outcome === "held"
				? `@${ws.data.handle} asked ${PLANNER_NAME} to stop. Its machine is disconnected, `
					+ "so its workflows will pause when it reconnects."
				: outcome === "unconfirmed"
				? `@${ws.data.handle} asked ${PLANNER_NAME} to stop its workflows. It has not confirmed `
					+ "yet, and if its machine is disconnected they will pause when it reconnects."
				: outcome === "failed" && !turn
				? `@${ws.data.handle} asked ${PLANNER_NAME} to stop, but its workflows could not be paused.`
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
				text: `@${ws.data.handle} stopped ${PLANNER_NAME} and withdrew its open question.`,
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
	let text = `@${ws.data.handle} resumed ${PLANNER_NAME}'s workflows.`;
	try {
		await session.resumeRuns();
	} catch (err) {
		console.error("[chat] resuming workflow runs failed:", err);
		text = `${PLANNER_NAME}'s workflows could not be resumed.`;
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
			text = `@${ws.data.handle} asked to pause ${run.name}. ${PLANNER_NAME} has not confirmed `
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
function storeStages(context: RunsRoom, cards: Wire.Run[]): Promise<void> | undefined {
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
async function forgetStages(context: RunsRoom, shown: Wire.Run[] | undefined): Promise<void> {
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
const owners = new WeakMap<Chat, Map<string, RunsOwner>>();
const unsaved = new WeakMap<RunsOwner, Runs>();
const gone = new WeakSet<RunsOwner>();

type Runs = { active: string[]; paused: string[]; cards?: Wire.Run[] };

/** The session whose runs a card shows: a retained Planner session, or one a restart rebuilt. */
type RunsOwner = Pick<PlannerSession, "suspended">;

/** What showing and storing a session's run cards needs of the room. */
type RunsRoom = Pick<Room, "chat" | "room" | "server" | "persist"> & {
	auth: { storage: Pick<Room["auth"]["storage"], "runStages"> };
};

/** Stand-ins, by session id, for the sessions a restart rebuilt whose clients report runs. */
const rebuiltOwners = new WeakMap<Chat, Map<string, { owner: RunsOwner; down: boolean }>>();

/**
 * Shows the runs reported by a Planner session a restart rebuilt and its client took back, `down`
 * while its client's link has dropped again. No turn of this process opened that session, so
 * nothing here retains it and its reports reach Chat only this way, as a retained session's do.
 */
export function rebuiltRuns(
	context: RunsRoom,
	session: string,
	runs: Runs,
	down = false,
): Promise<void> {
	if (context.chat.closed) return Promise.resolve();
	let known = rebuiltOwners.get(context.chat)
		?? new Map<string, { owner: RunsOwner; down: boolean }>();
	rebuiltOwners.set(context.chat, known);
	let entry = known.get(session);
	if (!entry) {
		let made: { owner: RunsOwner; down: boolean } = {
			owner: { suspended: () => made.down },
			down,
		};
		entry = made;
		known.set(session, entry);
	}
	entry.down = down;
	return publishRuns(context, entry.owner, runs);
}

/**
 * Show the session's runs, keeping ended ones as summary cards until the next
 * run starts, store them with the document so a reload keeps them, and say once
 * in the transcript when one ends. A card belongs to the session that reported
 * it: a report or release only changes its own session's cards.
 */
function publishRuns(
	context: RunsRoom,
	session: RunsOwner,
	runs: Runs | undefined,
	releasing = false,
	followUp?: (run: Wire.Run, said: string) => Promise<void>,
): Promise<void> {
	let known = owners.get(context.chat) ?? new Map<string, RunsOwner>();
	owners.set(context.chat, known);
	for (let run of runs?.cards ?? []) known.set(run.id, session);
	let turn = (publishing.get(context.chat) ?? Promise.resolve()).then(() =>
		publishReport(context, session, runs, releasing, followUp)
	);
	publishing.set(context.chat, turn);
	return turn;
}

async function publishReport(
	context: RunsRoom,
	session: RunsOwner,
	runs: Runs | undefined,
	releasing: boolean,
	followUp: ((run: Wire.Run, said: string) => Promise<void>) | undefined,
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
	for (let { run, said } of attention) await followUp?.(run, said);
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
			void publishRuns(
				context,
				opened.session,
				next,
				false,
				followUp ? (run, said) => followUpEndedRun(context, run, said) : undefined,
			);
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
			uploadImage: async ({ alt, bytes, mimeType }) => {
				if (
					chat.closed || !chat.busy || !chat.turnController || chat.turnController.signal.aborted
				) {
					throw new Error("images can be stored only during a Planner turn");
				}
				let images = turnImages(chat);
				let channel = await context.auth.storage.channels.get(room);
				if (!channel) throw new Error("this document is unavailable");
				if (channel.archivedAt) throw new Error("this document is archived");
				let uploadedBy = await imageOwner(context);
				let sha256 = createHash("sha256").update(bytes).digest("hex");
				await context.auth.storage.images.put({
					channelId: room,
					sha256,
					mimeType,
					bytes,
					uploadedBy,
					now: context.auth.clock(),
				});
				let path = imagePath(sha256, mimeType);
				let size = imageSize(mimeType, bytes);
				if (chat.turnImages === images) {
					later(images, () =>
						size
							? showImages(context, images, [{
								src: path,
								...(alt === undefined ? {} : { alt }),
								...size,
								generated: true,
							}])
							: showImages(context, images, [], undefined, [{
								before: 0,
								reason: `${headerRefusal(mimeType)}${alt ? ` Alt: ${alt}` : ""}`,
							}]));
				}
				return { path };
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

/**
 * What a reply sent from a thread with Also send to Chat does in the top-level Chat once it is
 * there, as a message said in Chat does: the room hears of it, and one to the room may draw the
 * Planner's initiative. One to the Planner is answered in its thread, and copied here as it is.
 */
export function copiedToChat(context: Room, ws: Socket, entry: Wire.Entry, focus?: string): void {
	let { chat } = context;
	context.roomMessagePublished?.();
	context.memberMessagePersisted?.(entry, context.claimantSessionId);
	if (entry.author.kind !== "member") return;
	chat.backscroll = remember(chat.backscroll, {
		entryId: entry.id,
		handle: entry.author.handle,
		text: entry.text,
		...(entry.references?.length ? { references: entry.references } : {}),
	});
	if (publicEntry(entry).to !== "planner") contributed(context, ws, entry, focus);
}

export function sessionBootstrap(
	chat: Chat,
	cursor: number,
	summary: string,
	currentEntryId?: string,
	currentReferences: Wire.Reference[] = [],
	overrideEntries?: Wire.Entry[],
): string | undefined {
	let start = Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= chat.entries.length
		? cursor
		: 0;
	let candidates = (overrideEntries
		?? (chat.forkBootstrap
			? [...chat.forkBootstrap, ...chat.entries.slice(start)]
			: chat.entries.slice(start)))
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
		// A thread's reply also sent to Chat, and the Planner's answer to it: said in the thread.
		if (entry.fromThread !== undefined) speaker = `${speaker} (in a thread, also sent to Chat)`;
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
	retry = false,
	bootstrapInPrompt = false,
): Promise<{ session: PlannerSession; binding: ActiveOwnerBinding; bootstrap?: string }> {
	let retained = context.chat.retained;
	let reader = !!context.chat.reader;
	let isolated = reader || !!context.chat.job;
	// A background job keeps its isolated session: it never borrows or ends the retained Planner.
	if (retained && !isolated) {
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
		) {
			throw new PlannerOwnerUnavailableError(
				`${PLANNER_NAME}'s owner changed while opening. Try again.`,
			);
		}
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
		// A reader's session has no tools and no history of its own, so it neither forks nor moves the
		// Planner's session tree: its reply stays untracked, for the next Planner turn to be told.
		let forkSetup = !isolated
			? context.sessionForks?.prepareTurn(currentEntryId, retry)
			: undefined;
		let fullBootstrap = sessionBootstrap(
			chat,
			ownership.transcriptCursor,
			ownership.summary,
			currentEntryId,
			currentReferences,
		);
		let nativeBootstrap = forkSetup?.skipBootstrap
			? sessionBootstrap(
				chat,
				ownership.transcriptCursor,
				ownership.summary,
				currentEntryId,
				currentReferences,
				forkSetup.untrackedEntries ?? [],
			)
			: fullBootstrap;
		let open = context.openPlannerSession
			?? (await import("../harness/session")).openPlannerSession;
		// What the room said changes every turn, and a fresh session starts for each one, so it goes
		// before the turn's prompt: the instructions stay the same from turn to turn, and the model
		// provider can reuse its cache of them instead of reading them all again.
		let bootstrap: string | undefined;
		let result = await open(binding, {
			room: documentRoom(context),
			repository,
			chat,
			...(forkSetup?.fork ? { fork: forkSetup.fork } : {}),
			instructions: reader ? READER_INSTRUCTIONS : workspace => {
				let usedNative = !!forkSetup?.skipBootstrap
					&& !(workspace && "remote" in workspace && workspace.forkedNatively === false);
				let chosen = usedNative ? nativeBootstrap : fullBootstrap;
				if (bootstrapInPrompt) bootstrap = chosen;
				return plannerInstructions(
					`${repository.owner}/${repository.name}`,
					bootstrapInPrompt ? undefined : chosen,
					workspace,
					visualRouting(context),
				);
			},
			model: context.config.model || undefined,
			harness: context.config.harness,
			...(reader ? { reader: true as const } : {}),
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
				`${PLANNER_NAME}'s session changed while opening. Try again.`,
			);
		}
		chat.agent = opened;
		chat.owner = openingOwner;
		if (!isolated) consumeBootstrapBackscroll(chat);
		else chat.bootstrapEntries = undefined;
		return { session: opened, binding, ...(bootstrap ? { bootstrap } : {}) };
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

/** Run one turn, then start the next of Chopin's own that waited behind it. */
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
	let skipped = false;
	let reader = !!about?.reader;
	let isolated = reader || !!jobTurn;
	chat.backgroundTurn = jobTurn;

	if (!reserved) {
		chat.busy = true;
		// A background job's turn is neither saved nor shown: Chat draws nothing for it.
		chat.turn = begin(handle, chat.entries.length, !!jobTurn);
		chat.acting = thread;
		chat.actingChannel = about?.threadChannel;
		(jobTurn ? jobState : state)(chat, server, room);
	} else {
		chat.acting = thread;
		chat.actingChannel = about?.threadChannel;
	}
	// A turn a person can talk to takes their messages as it works. A background job's session is
	// isolated: it takes none.
	let steered = !jobTurn && chat.turn ? steering(chat.turn.id) : undefined;
	chat.steering = steered;
	try {
		about?.started?.();
	} catch (err) {
		console.error("[chat] an instruction's start could not be recorded:", err);
	}
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
	chat.toolEntries = new Map();
	if (!jobTurn) chat.captured = new Set();
	if (jobTurn) {
		chat.job = jobTurn.job;
		chat.jobOutput = undefined;
		chat.jobFailures = 0;
		chat.jobFailureCode = undefined;
		chat.jobCalls = new Map();
	}
	if (reader) chat.reader = true;
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
	let held = isolated ? chat.retained : undefined;
	let heldOwner = chat.owner;
	let heldReferences = held ? new Map(chat.referenceCache) : undefined;
	try {
		if (about?.authorize && !await about.authorize()) {
			skipped = true;
			turnController.abort();
			throw new Error("The turn is no longer authorized.");
		}
		// A skill or a prompt template has to open the prompt, as a background job's header does, so
		// their fresh sessions are told what the room said in their instructions instead.
		let command = jobTurn || reader ? undefined : commandReference(references);
		let { bootstrap, ...repositoryOpened } = await repositorySession(
			context,
			claimantSessionId,
			member?.entryId,
			references,
			!!member?.retry,
			!jobTurn && (command === undefined || command.commandKind === COMMAND_KINDS.workflow),
		);
		opened = repositoryOpened;
		// Given once, with the session's first prompt.
		let withBootstrap = (text: string) => {
			let told = bootstrap;
			bootstrap = undefined;
			return withSessionContext(told, text);
		};
		if (about?.signal && about.spent?.()) turnController.abort();
		if (chat.agent !== opened.session || turnController.signal.aborted) {
			throw new Error(`${PLANNER_NAME}'s session changed before the turn started. Try again.`);
		}
		chat.jobToolNames = jobTurn
			? new Set(opened.session.activeTools ?? PLANNER_TOOL_NAMES)
			: undefined;
		let prompt: string;
		// The files sent with the message that began the turn, given with the first attempt's prompt.
		let files: PlannerFiles | undefined;
		if (jobTurn) {
			prompt = jobTurn.prompt;
		} else if (reader) {
			// The backscroll and references are the writers' to take.
			prompt = text;
		} else {
			// A skill or a prompt template is Atomic's own `/name args`, which has to open the prompt:
			// what the room said and the focus line wait for the next turn instead of standing before it.
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
			// Only the first attempt runs the message again; a repair continues it.
			let retrying = !!member?.retry;
			await publishPlannerReplies({
				session: {
					stream: async (text, abort, _choice, sent) => {
						let answers = member
							? { id: member.entryId, ...(retrying ? { retry: true as const } : {}) }
							: undefined;
						retrying = false;
						let result = await session.stream(withBootstrap(text), abort, choice, sent, answers);
						// Its first call is made: a message given to the turn now reaches it, and
						// people are told the turn is running, as the machine has its prompt.
						steered?.open(session);
						if (reserved && member) state(chat, server, room);
						return result;
					},
				},
				prompt,
				...(files ? { files } : {}),
				signal,
				decide: context.decide,
				repair: !reader,
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
				quiet: quiet => quieten(chat, server, room, quiet),
				beginAttempt: () => {
					chat.toolEntries = new Map();
					if (chat.turnImages) chat.turnImages.calls = new Set();
				},
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
		// A job that gave way to a person's turn did not fail: it runs again later.
		if (!jobTurn?.preempted) console.error("[chat] turn failed:", err);
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
		steered?.end();
		if (chat.steering === steered) chat.steering = undefined;
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
				opened && !chat.closed && !isolated
				&& (!failed || replyOnly || opened.session.suspended?.())
			) kept = retain(context, opened);
			if (!kept) {
				if (!isolated && chat.retained?.session === opened?.session) await chat.retained?.release();
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
							text: `${PLANNER_NAME}'s session could not close cleanly. Try again.`,
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
		await endTurnImages(chat);
		chat.messageIds = undefined;
		chat.toolEntries = undefined;
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
		chat.reader = undefined;
		if (!isolated && context.sessionForks) {
			try {
				await context.sessionForks.finishTurn(began.request, chat.entries.slice(firstEntry));
			} catch (err) {
				console.error("[chat] could not save session fork state:", err);
			}
		}
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
			if (jobTurn.preempted && !chat.closed && !persistenceError) {
				// What its own tool wrote before it gave way is its result; with none, it runs again.
				let output = jobTurn.output ?? (outcome?.status === "done" ? outcome.output : undefined);
				outcome = output === undefined ? PREEMPTED : { status: "done", output };
			}
			if (outcome?.status !== "preempted") {
				chat.preemptions?.delete(`${jobTurn.job.kind}:${jobTurn.job.target}`);
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
			status: failed || persistenceError
				? "failed"
				: skipped
				? "skipped"
				: stopped
				? "stopped"
				: "done",
			...(said?.text.trim() ? { text: said.text } : {}),
		});
	}

	if (chat.closed) return;
	return drain(context, { job: !!jobTurn, outcome });
}

/**
 * Starts the next of Chopin's own waiting turns, if one may start. Called when a turn has ended
 * (`ended` says how) and, with none running, when something that held them is over (`ended`
 * absent).
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
	// A person's turn that preempted a job goes first.
	let preempting = chat.preempting;
	chat.preempting = undefined;
	if (preempting && !startsHeld) {
		chat.starting = false;
		if (ended) await run(...preempting);
		else startRun(...preempting);
		return;
	}
	let next = startsHeld ? undefined : pending(chat);
	if (next) {
		if (next.job) chat.handoffJob = next.job;
		try {
			await context.persist();
		} catch (err) {
			if (chat.handoffJob === next.job) chat.handoffJob = undefined;
			console.error("[chat] could not save a waiting turn:", err);
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
			// Settled while its handoff save was pending: it never runs, and the next one is tried.
			return startNext(context, ended);
		}
		if (chat.preempting) {
			// A person asked while it was handed the Chat: it waits behind their turn.
			chat.waiting.unshift(next);
			return startNext(context, ended);
		}
		let turnContext = { ...context };
		let turn = [
			turnContext,
			next.handle,
			next.text,
			next,
			claimantOf(context, next),
			false,
			undefined,
			undefined,
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
	chat.backgroundTurn = undefined;
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
 * The next waiting turn worth running.
 *
 * A turn whose work is already done is dropped rather than run: an initiative proposal for a
 * message somebody has since answered is not worth a pass over the plan. Only something that waited
 * behind a turn can be spent, which is why the question is asked here and not when it was accepted.
 */
export function pending(chat: Chat): Waiting | undefined {
	let next = chat.waiting.shift();
	while (next?.spent?.()) {
		void report(next, { status: "skipped" });
		next = chat.waiting.shift();
	}
	return next;
}

/** The login whose Copilot entitlement runs a waiting turn. */
function claimantOf(context: Room, next: Waiting): string | undefined {
	if (next.job?.job.kind === "decision-followup" || next.reader) return undefined;
	return next.sessionId ?? context.claimantSessionId;
}

function readTokenNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return Math.floor(value);
	}
	if (value && typeof value === "object" && "total" in value) {
		let total = (value as { total?: unknown }).total;
		if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
			return Math.floor(total);
		}
	}
	return 0;
}

function readCachedTokens(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	let item = value as { cachedInputTokens?: unknown; inputTokens?: unknown };
	if (typeof item.cachedInputTokens === "number" && item.cachedInputTokens > 0) {
		return Math.floor(item.cachedInputTokens);
	}
	if (item.inputTokens && typeof item.inputTokens === "object") {
		let cacheRead = (item.inputTokens as { cacheRead?: unknown }).cacheRead;
		if (typeof cacheRead === "number" && cacheRead > 0) return Math.floor(cacheRead);
	}
	return 0;
}

function recordUsage(context: Room, rawUsage: unknown): void {
	if (!rawUsage || typeof rawUsage !== "object") return;
	let item = rawUsage as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
	let inputTokens = readTokenNumber(item.inputTokens);
	let outputTokens = readTokenNumber(item.outputTokens);
	let totalTokens = readTokenNumber(item.totalTokens) || inputTokens + outputTokens;
	if (totalTokens <= 0) return;
	let cachedTokens = readCachedTokens(rawUsage);
	let contextWindow = context.chat.contextWindow && context.chat.contextWindow > 0
		? context.chat.contextWindow
		: 128_000;
	let usage: Wire.ContextUsage = {
		messages: totalTokens,
		inputTokens,
		outputTokens,
		...(cachedTokens > 0 ? { cachedTokens } : {}),
		totalTokens,
		contextWindow,
	};
	context.chat.usage = usage;
	broadcast(context.server, context.room, { kind: "chat:context", ts: 0, usage });
	void Promise.resolve(context.onSessionMetaChanged?.()).catch(err =>
		console.error("[chat] could not persist context usage:", err)
	);
}

function isHarnessCompactionCall(
	part: { toolCallId: string; toolName: string; providerExecuted?: boolean },
): boolean {
	return part.providerExecuted === true && part.toolName === "compaction"
		&& part.toolCallId.startsWith("harness-compaction-");
}

/** Project one AI SDK stream part into the shared Conversation. */
export function translate(context: Room, part: TextStreamPart<ToolSet>): void {
	let { chat, room, server } = context;
	if (chat.job || chat.jobToolNames) return translateJob(context, part);
	let ids = chat.messageIds ??= new Map();
	switch (part.type) {
		case "raw": {
			let raw = part.rawValue as Record<string, unknown> | null | undefined;
			if (!raw || typeof raw !== "object") return;
			if (raw.type === "compacting") {
				chat.compacting = true;
				broadcast(server, room, { kind: "chat:compaction", ts: 0, status: "compacting" });
			} else if (raw.type === "compaction-idle") {
				chat.compacting = false;
				broadcast(server, room, { kind: "chat:compaction", ts: 0, status: "idle" });
			} else if (
				raw.type === "context-window" && typeof raw.contextWindow === "number"
				&& raw.contextWindow > 0
			) {
				chat.contextWindow = Math.floor(raw.contextWindow);
			}
			return;
		}
		case "finish-step":
			recordUsage(context, part.usage);
			return;
		case "finish":
			chat.tooling = undefined;
			recordUsage(context, part.totalUsage);
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
					...answeringReaction(chat),
				} as Wire.Entry);
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
			if (isHarnessCompactionCall(part)) return;
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
			if (part.type === "tool-result" && isHarnessCompactionCall(part)) {
				let output = (part.output ?? {}) as {
					trigger?: unknown;
					summary?: unknown;
					tokensBefore?: unknown;
					tokensAfter?: unknown;
				};
				let priorSummarized = (chat.compactions ?? []).reduce(
					(sum, item) => sum + item.messagesSummarized,
					0,
				);
				let allMessages = [
					...(chat.forkBootstrap ?? []),
					...chat.entries,
				].filter(entry => entry.author.kind !== "system").length;
				let messagesSummarized = Math.max(1, allMessages - priorSummarized);
				let compaction: Wire.CompactionRecord = {
					id: ulid(),
					...(chat.entries.at(-1)?.id ? { afterEntryId: chat.entries.at(-1)!.id } : {}),
					summary: typeof output.summary === "string" ? output.summary : "",
					messagesSummarized,
					...(typeof output.tokensBefore === "number"
						? { tokensBefore: Math.floor(output.tokensBefore) }
						: {}),
					...(typeof output.tokensAfter === "number"
						? { tokensAfter: Math.floor(output.tokensAfter) }
						: {}),
					trigger: output.trigger === "manual" ? "manual" : "auto",
					ts: now(),
				};
				(chat.compactions ??= []).push(compaction);
				chat.compacting = false;
				broadcast(server, room, {
					kind: "chat:compaction",
					ts: 0,
					status: "compacted",
					compaction,
				});
				void Promise.resolve(context.onSessionMetaChanged?.()).catch(err =>
					console.error("[chat] could not persist compaction:", err)
				);
				return;
			}
			let preliminary = part.type === "tool-result" && part.preliminary === true;
			let success = part.type === "tool-result";
			let output = part.type === "tool-result"
				? part.output
				: part.type === "tool-error"
				? part.error
				: "Refused.";
			let staged: ToolImage[] = [];
			let refused: Wire.ImageRefusal[] = [];
			if (success && !preliminary && !chat.turnImages?.calls.has(part.toolCallId)) {
				({ images: staged, refusals: refused } = inspectImages(output));
				if (staged.length || refused.length) turnImages(chat).calls.add(part.toolCallId);
			}
			conclude(
				context,
				part.toolCallId,
				output,
				preliminary ? "running" : success ? "done" : "failed",
				success,
				part.type === "tool-output-denied",
			);
			if (staged.length || refused.length) stageImages(context, staged, refused, part.toolCallId);
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
			? `Reference content was returned privately to ${PLANNER_NAME}.`
			: "The reference could not be read."
		: failure
		? textOutput(failure.message)
		: outputText(toolRowOutput(output));
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
	if (!chat.reader && (chat.agent?.activeTools ?? PLANNER_TOOL_NAMES).includes(name)) return true;
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

function holder(chat: Chat, id: string): Wire.Entry | undefined {
	let entry = chat.entries.find(item => item.id === chat.toolEntries?.get(id));
	return entry?.tools?.some(activity => activity.id === id) ? entry : undefined;
}

function tool(chat: Chat, id: string): Wire.Activity | undefined {
	return holder(chat, id)?.tools?.find(item => item.id === id);
}

/** What a running tool call was called, from where it was filed. */
function named(chat: Chat, id: string): string {
	return tool(chat, id)?.name ?? "tool";
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
	let entry = holder(chat, activity.id)
		?? chat.entries.find(item => item.id === chat.tooling)
		?? chat.entries.find(item => item.id === chat.writing);
	if (entry && !entry.tools?.some(tool => tool.id === activity.id)) chat.tooling = entry.id;

	if (!entry) {
		entry = {
			id: ulid(),
			author: { kind: "agent" },
			text: "",
			ts: now(),
			tools: [],
			...answeringReaction(chat),
		} as Wire.Entry;
		chat.tooling = entry.id;
		say(chat, server, room, entry);
	}

	entry.tools ??= [];
	let existing = entry.tools.findIndex(item => item.id === activity.id);
	if (existing >= 0) entry.tools[existing] = { ...entry.tools[existing], ...activity };
	else entry.tools.push(activity);
	(chat.toolEntries ??= new Map()).set(activity.id, entry.id);
	return entry.id;
}

/** Whoever the turn is for owns what it stores; a turn nobody asked for is the Planner owner's. */
async function imageOwner(
	context: Room,
	member = currentMemberRequest(context.chat)?.userId,
): Promise<string> {
	let uploadedBy = member;
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
	return uploadedBy;
}

function turnImages(chat: Chat): TurnImages {
	return chat.turnImages ??= { work: Promise.resolve(), calls: new Set() };
}

export async function endTurnImages(chat: Chat): Promise<void> {
	let images = chat.turnImages;
	if (!images) return;
	let work: Promise<void>;
	do {
		work = images.work;
		await work;
	} while (images.work !== work);
	if (chat.turnImages === images) chat.turnImages = undefined;
}

function later(images: TurnImages, work: () => void | Promise<void>): void {
	images.work = images.work.then(work).catch(err => {
		console.error("[chat] could not show an image in Chat:", err);
	});
}

function showImages(
	context: Room,
	turn: TurnImages,
	images: Wire.Image[],
	held?: string,
	refusals: Wire.ImageRefusal[] = [],
): void {
	let { chat, room, server } = context;
	if (chat.closed || !(images.length || refusals.length) || chat.turnImages !== turn) return;
	let entry = chat.entries.find(item => item.id === turn.entry)
		?? chat.entries.find(item => item.id === held)
		?? chat.entries.find(item => item.id === chat.tooling)
		?? chat.entries.find(item => item.id === chat.writing);
	if (!entry) {
		entry = { id: ulid(), author: { kind: "agent" }, text: "", ts: now() };
		chat.entries.push(entry);
	}
	turn.entry = entry.id;
	let before = entry.images?.length ?? 0;
	if (images.length) entry.images = [...entry.images ?? [], ...images];
	if (refusals.length) {
		entry.refusedImages = [
			...entry.refusedImages ?? [],
			...refusals.map(refusal => ({ ...refusal, before: before + refusal.before })),
		];
	}
	announce(server, room, entry);
}

function stageImages(
	context: Room,
	images: ToolImage[],
	refusals: Wire.ImageRefusal[],
	call: string,
): void {
	let { auth, room } = context;
	let member = currentMemberRequest(context.chat)?.userId;
	let turn = turnImages(context.chat);
	let held = holder(context.chat, call)?.id;
	later(turn, async () => {
		let shown: Wire.Image[] = [];
		let notes: Wire.ImageRefusal[] = [];
		let waiting = [...refusals];
		let uploadedBy: string | undefined;
		for (let [index, original] of images.entries()) {
			while (waiting[0] && waiting[0].before <= index) {
				notes.push({ ...waiting.shift()!, before: shown.length });
			}
			let image = await fitImage(original, context.config.imageMaxBytes);
			if ("reason" in image) {
				notes.push({ before: shown.length, reason: image.reason });
				continue;
			}
			try {
				uploadedBy ??= await imageOwner(context, member);
				let sha256 = createHash("sha256").update(image.bytes).digest("hex");
				await auth.storage.images.put({
					channelId: room,
					sha256,
					mimeType: image.mimeType,
					bytes: image.bytes,
					uploadedBy,
					now: auth.clock(),
				});
				shown.push({
					src: imagePath(sha256, image.mimeType),
					...(image.alt === undefined ? {} : { alt: image.alt }),
					...(image.caption === undefined ? {} : { caption: image.caption }),
					width: image.width,
					height: image.height,
					generated: true,
				});
			} catch (err) {
				console.error("[chat] could not store an image to show in Chat:", err);
				notes.push({ before: shown.length, reason: STORE_REFUSAL });
			}
		}
		for (let refusal of waiting) notes.push({ ...refusal, before: shown.length });
		showImages(context, turn, shown, held, notes);
	});
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
	if (chat.childChats) {
		for (let child of chat.childChats.values()) {
			await resetAgent(child, sessionId, revision, reason);
		}
	}
}

/** Let go of the session. The conversation is resumable by id. */
export async function close(chat: Chat): Promise<void> {
	let childChats = chat.childChats ? [...chat.childChats.values()] : [];
	chat.childChats?.clear();
	await Promise.all(childChats.map(child => close(child)));
	// What was admitted before this finishes first: a message that was being saved is saved and
	// answered, not refused as closed. Whatever arrives once the Chat is closed is refused.
	for (let admitted: Promise<void> | undefined; admitted !== chat.sending;) {
		admitted = chat.sending;
		await admitted;
	}
	chat.closed = true;
	chat.initiative?.close();
	chat.reactions?.close();
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
	chat.preempting = undefined;
	chat.turnController?.abort();
	chat.referenceCache.clear();
	chat.bootstrapEntries = undefined;
	chat.openingOwner = undefined;
	clearTimeout(chat.lingering);
	chat.lingering = undefined;
	await Promise.all([chat.sending, chat.running]);
	await chat.retained?.release();
}
