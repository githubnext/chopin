import { summarizeThread } from "@chopin/protocol/threads";

import { broadcast, fail, PASSING, reply, tell } from "../wire";
import * as Chat from "./service";

import type { Chat as Wire, Frame, Outgoing, Request } from "@chopin/protocol";
import type { Server } from "bun";
import type { PlannerForkHooks } from "../harness/session";
import type {
	ChatSessionState,
	ChatThreadForkState,
	ChatThreadRecord,
	EntryForkPoint,
	JsonValue,
	Lease,
} from "../storage/model";
import type { ChatThreadStore } from "../storage/port";
import type { Socket, SocketData } from "../wire";

export type ThreadPersistence = {
	store: ChatThreadStore;
	lease: () => Lease;
};

type ManagedThread = {
	record: ChatThreadRecord;
	chat: Chat.Chat;
	untrackedAfterFork: Wire.Entry[];
	lastRemoteTurn?: { session: string; turn: string };
};

type ChannelThreads = {
	loaded: boolean;
	loading?: Promise<void>;
	threads: Map<string, ManagedThread>;
	entryForks: Record<string, EntryForkPoint>;
	atomicEntries?: JsonValue[];
	atomicLeafId?: string | null;
	lastRemoteTurn?: { session: string; turn: string };
};

let channels = new WeakMap<Chat.Chat, ChannelThreads>();

function channelState(topChat: Chat.Chat): ChannelThreads {
	let found = channels.get(topChat);
	if (!found) {
		found = {
			loaded: false,
			threads: new Map(),
			entryForks: {},
		};
		channels.set(topChat, found);
	}
	return found;
}

function resolvePersistence(
	context: Chat.Room,
	override?: ThreadPersistence,
): ThreadPersistence | undefined {
	if (override) return override;
	let persistence = (
		context.plan as unknown as {
			persistence?: { storage: { chatThreads: ChatThreadStore }; lease: () => Lease };
		}
	)?.persistence;
	if (!persistence) return undefined;
	return {
		store: persistence.storage.chatThreads,
		lease: persistence.lease,
	};
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function buildManagedThread(topChat: Chat.Chat, record: ChatThreadRecord): ManagedThread {
	let threadChat = Chat.restore(record.entries);
	threadChat.forkBootstrap = structuredClone(record.forkState.bootstrapEntries);
	threadChat.compactions = structuredClone(record.compactions);
	threadChat.usage = record.usage ? structuredClone(record.usage) : undefined;
	if (record.usage?.contextWindow) threadChat.contextWindow = record.usage.contextWindow;
	(topChat.childChats ??= new Map()).set(record.rootId, threadChat);
	return {
		record: structuredClone(record),
		chat: threadChat,
		untrackedAfterFork: [],
	};
}

async function ensureLoaded(
	context: Chat.Room,
	override?: ThreadPersistence,
): Promise<ChannelThreads> {
	let state = channelState(context.chat);
	if (state.loaded) return state;
	let persistence = resolvePersistence(context, override);
	if (!persistence) {
		state.loaded = true;
		return state;
	}
	state.loading ??= (async () => {
		let [sessionState, storedThreads] = await Promise.all([
			persistence.store.getSessionState(context.room),
			persistence.store.listThreads(context.room),
		]);
		if (sessionState) {
			state.entryForks = structuredClone(sessionState.entryForks);
			state.atomicEntries = sessionState.atomicEntries
				? structuredClone(sessionState.atomicEntries)
				: undefined;
			state.atomicLeafId = sessionState.atomicLeafId;
			context.chat.compactions = structuredClone(sessionState.compactions);
			context.chat.usage = sessionState.usage
				? structuredClone(sessionState.usage)
				: undefined;
			if (sessionState.usage?.contextWindow) {
				context.chat.contextWindow = sessionState.usage.contextWindow;
			}
		}
		for (let record of storedThreads) {
			if (!state.threads.has(record.rootId)) {
				state.threads.set(record.rootId, buildManagedThread(context.chat, record));
			}
		}
		state.loaded = true;
	})();
	try {
		await state.loading;
	} finally {
		state.loading = undefined;
	}
	return state;
}

async function saveTopSessionState(
	context: Chat.Room,
	state: ChannelThreads,
	override?: ThreadPersistence,
): Promise<void> {
	let persistence = resolvePersistence(context, override);
	if (!persistence) return;
	let record: ChatSessionState = {
		channelId: context.room,
		compactions: structuredClone(context.chat.compactions ?? []),
		...(context.chat.usage ? { usage: structuredClone(context.chat.usage) } : {}),
		...(state.atomicEntries !== undefined
			? {
				atomicEntries: structuredClone(state.atomicEntries),
				atomicLeafId: state.atomicLeafId ?? null,
			}
			: {}),
		entryForks: structuredClone(state.entryForks),
		updatedAt: new Date(),
	};
	await persistence.store.putSessionState(persistence.lease(), record);
}

async function saveThreadRecord(
	context: Chat.Room,
	managed: ManagedThread,
	override?: ThreadPersistence,
): Promise<void> {
	managed.record.entries = managed.chat.entries.map(Chat.publicEntry);
	managed.record.compactions = structuredClone(managed.chat.compactions ?? []);
	if (managed.chat.usage) managed.record.usage = structuredClone(managed.chat.usage);
	else delete managed.record.usage;
	managed.record.updatedAt = new Date();
	let persistence = resolvePersistence(context, override);
	if (!persistence) return;
	await persistence.store.putThread(persistence.lease(), managed.record);
}

/**
 * Compute the exact fork state at `rootIndex` in `topEntries`:
 * - `bootstrapEntries` carries the conversation up to and including the root message (never later).
 * - When Atomic recorded a session tree at or before `rootIndex`, `atomicEntries` and
 *   `atomicLeafId` branch the Atomic session at that exact entry.
 * - When `remote` recorded a turn at or before `rootIndex`, `remoteFrom` names that session and
 *   turn for `fork` over `session-forks`.
 * - Any room-only messages between that last Planner turn and `rootIndex` are kept in
 *   `untrackedAfterFork` so native forks still see what collaborators said up to the root.
 */
function buildInitialFork(
	state: ChannelThreads,
	topEntries: readonly Wire.Entry[],
	rootIndex: number,
): { forkState: ChatThreadForkState; untrackedAfterFork: Wire.Entry[] } {
	let prefix = topEntries.slice(0, rootIndex + 1).map(Chat.publicEntry);
	let atomicLeafId: string | null | undefined;
	let atomicIndex = -1;
	let remoteFrom: { session: string; turn?: string } | undefined;
	let remoteIndex = -1;

	for (let index = rootIndex; index >= 0; index--) {
		let point = state.entryForks[prefix[index]!.id];
		if (!point) continue;
		if (atomicLeafId === undefined && point.atomicLeafId !== undefined) {
			atomicLeafId = point.atomicLeafId;
			atomicIndex = index;
		}
		if (remoteFrom === undefined && point.remote !== undefined) {
			remoteFrom = { ...point.remote };
			remoteIndex = index;
		}
		if (atomicLeafId !== undefined && remoteFrom !== undefined) break;
	}

	let hasAtomic = atomicLeafId !== undefined && !!state.atomicEntries?.length;
	let forkState: ChatThreadForkState = {
		bootstrapEntries: prefix,
		...(hasAtomic
			? {
				atomicEntries: structuredClone(state.atomicEntries!),
				atomicLeafId,
			}
			: {}),
		...(remoteFrom ? { remoteFrom } : {}),
	};

	let nativeIndex = hasAtomic ? atomicIndex : remoteFrom ? remoteIndex : -1;
	let untrackedAfterFork = nativeIndex >= 0 ? prefix.slice(nativeIndex + 1) : [];
	return { forkState, untrackedAfterFork };
}

const THREAD_FRAME_KINDS = new Set<string>([
	"chat:message",
	"chat:delta",
	"chat:tool",
	"chat:state",
	"chat:queue",
	"chat:removed",
	"chat:context",
	"chat:compaction",
]);

function wrapThreadServer(
	server: Server<SocketData>,
	room: string,
	managed: ManagedThread,
): Server<SocketData> {
	let publishSummary = () => {
		let summary = summarizeThread(
			managed.record.rootId,
			managed.record.forkedAt,
			managed.chat.entries.map(Chat.publicEntry),
		);
		broadcast(server, room, {
			kind: "chat:thread-summary",
			ts: 0,
			summary,
		});
	};

	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop !== "publish") {
				let value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (
				topicName: string,
				data: string | ArrayBufferView | ArrayBuffer,
				compress?: boolean,
			) => {
				if (typeof data === "string") {
					try {
						let parsed = JSON.parse(data) as Frame;
						if (THREAD_FRAME_KINDS.has(parsed.kind)) {
							let wrapped: Wire.InThread = {
								kind: "chat:in-thread",
								ts: parsed.ts || nowSeconds(),
								rootId: managed.record.rootId,
								frame: parsed as Wire.InThreadFrame,
							};
							let result = target.publish(topicName, JSON.stringify(wrapped), compress);
							if (parsed.kind === "chat:message" || parsed.kind === "chat:removed") {
								publishSummary();
							}
							return result;
						}
					} catch {
						// Fall through to raw publish if non-JSON.
					}
				}
				return target.publish(topicName, data as string, compress);
			};
		},
	});
}

/**
 * Before a Retry runs a message's turn again: the Atomic session tree goes back to the leaf it had
 * before the failed attempt, and the fork points recorded for the message and what followed it are
 * forgotten, so neither the next turn's session nor a later thread fork holds the attempt. What
 * members said after the message is then untracked, and the turn is given it as transcript.
 */
function rewind(state: ChannelThreads, entries: readonly Wire.Entry[], entryId: string): void {
	let at = entries.findIndex(entry => entry.id === entryId);
	if (at < 0) return;
	for (let entry of entries.slice(at)) delete state.entryForks[entry.id];
	if (!state.atomicEntries?.length) return;
	let leaf: string | null = null;
	for (let index = at - 1; index >= 0; index--) {
		let point = state.entryForks[entries[index]!.id];
		if (point?.atomicLeafId !== undefined) {
			leaf = point.atomicLeafId;
			break;
		}
	}
	state.atomicLeafId = leaf;
}

/** Attach top-level session fork, context-usage and compaction hooks to a top-level `Chat.Room`. */
export function bindTopLevel(
	context: Chat.Room,
	override?: ThreadPersistence,
): Chat.Room {
	if (context.rootChannelId || context.sessionForks) return context;
	let state = channelState(context.chat);
	return {
		...context,
		sessionForks: {
			prepareTurn(currentEntryId, retry) {
				if (retry && currentEntryId) rewind(state, context.chat.entries, currentEntryId);
				let hasAtomic = !!state.atomicEntries?.length;
				let untrackedEntries = hasAtomic
					? context.chat.entries.filter(
						entry =>
							entry.id !== currentEntryId
							&& state.entryForks[entry.id]?.atomicLeafId === undefined,
					)
					: undefined;
				let fork: PlannerForkHooks = {
					...(hasAtomic
						? {
							atomicEntries: state.atomicEntries,
							atomicLeafId: state.atomicLeafId,
						}
						: {}),
					onAtomicEntries: (entries, leafId) => {
						state.atomicEntries = entries as JsonValue[];
						state.atomicLeafId = leafId;
					},
					onRemoteTurn: point => {
						state.lastRemoteTurn = point;
					},
				};
				return {
					fork,
					skipBootstrap: hasAtomic,
					untrackedEntries,
				};
			},
			async finishTurn(requestEntryId, turnEntries) {
				let point: EntryForkPoint = {
					...(state.atomicEntries?.length ? { atomicLeafId: state.atomicLeafId ?? null } : {}),
					...(state.lastRemoteTurn ? { remote: { ...state.lastRemoteTurn } } : {}),
				};
				if (point.atomicLeafId !== undefined || point.remote !== undefined) {
					if (requestEntryId) state.entryForks[requestEntryId] = { ...point };
					for (let entry of turnEntries) {
						if (entry.author.kind !== "system") {
							state.entryForks[entry.id] = { ...point };
						}
					}
				}
				await saveTopSessionState(context, state, override);
			},
		},
		onSessionMetaChanged: () => saveTopSessionState(context, state, override),
	};
}

function buildThreadRoom(
	topContext: Chat.Room,
	managed: ManagedThread,
	override?: ThreadPersistence,
): Chat.Room {
	let wrappedServer = wrapThreadServer(topContext.server, topContext.room, managed);
	return {
		investigations: topContext.investigations,
		chat: managed.chat,
		plan: topContext.plan,
		server: wrappedServer,
		room: topContext.room,
		config: topContext.config,
		decide: topContext.decide,
		visualAdmission: topContext.visualAdmission,
		auth: topContext.auth,
		claimantSessionId: topContext.claimantSessionId,
		repository: topContext.repository,
		plannerNotAttached: topContext.plannerNotAttached,
		plannerStarting: topContext.plannerStarting,
		steers: topContext.steers,
		activeOwner: topContext.activeOwner,
		openPlannerSession: topContext.openPlannerSession,
		modelChoice: topContext.modelChoice,
		commands: topContext.commands,
		fileExists: topContext.fileExists,
		readsImages: topContext.readsImages,
		ownerAvailable: topContext.ownerAvailable,
		references: topContext.references,
		hold: topContext.hold,
		children: topContext.children,
		persist: async () => {
			await saveThreadRecord(topContext, managed, override);
		},
		sessionForks: {
			prepareTurn(currentEntryId) {
				let forkState = managed.record.forkState;
				let hasAtomic = !!forkState.atomicEntries?.length;
				let hasRemote = !!forkState.remoteFrom;
				let untrackedEntries = [
					...managed.untrackedAfterFork,
					...managed.chat.entries.filter(
						entry =>
							entry.id !== currentEntryId
							&& entry.author.kind === "member"
							&& entry.to !== "planner",
					),
				];
				let fork: PlannerForkHooks = {
					...(hasAtomic
						? {
							atomicEntries: forkState.atomicEntries,
							atomicLeafId: forkState.atomicLeafId,
						}
						: {}),
					onAtomicEntries: (entries, leafId) => {
						forkState.atomicEntries = entries as JsonValue[];
						forkState.atomicLeafId = leafId;
					},
					...(hasRemote ? { remoteFrom: { ...forkState.remoteFrom! } } : {}),
					onRemoteTurn: point => {
						managed.lastRemoteTurn = point;
						forkState.remoteFrom = { ...point };
					},
				};
				return {
					fork,
					skipBootstrap: hasAtomic || hasRemote,
					untrackedEntries,
				};
			},
			async finishTurn() {
				// Once the first forked turn finishes, trailing room messages before the root are in context.
				managed.untrackedAfterFork = [];
				await saveThreadRecord(topContext, managed, override);
			},
		},
		onSessionMetaChanged: () => saveThreadRecord(topContext, managed, override),
	};
}

async function ensureThreadForRoot(
	topContext: Chat.Room,
	state: ChannelThreads,
	rootId: string,
	handle: string,
	createIfMissing: boolean,
	override?: ThreadPersistence,
): Promise<{ managed?: ManagedThread; root?: Wire.Entry }> {
	let existing = state.threads.get(rootId);
	let rootIndex = topContext.chat.entries.findIndex(entry => entry.id === rootId);
	let liveRoot = rootIndex >= 0 ? Chat.publicEntry(topContext.chat.entries[rootIndex]!) : undefined;
	if (existing) {
		if (liveRoot) existing.record.root = liveRoot;
		return { managed: existing, root: existing.record.root };
	}
	if (!liveRoot) return {};
	if (!createIfMissing) return { root: liveRoot };

	let { forkState, untrackedAfterFork } = buildInitialFork(
		state,
		topContext.chat.entries,
		rootIndex,
	);
	let record: ChatThreadRecord = {
		channelId: topContext.room,
		rootId,
		root: liveRoot,
		forkedAt: nowSeconds(),
		createdBy: handle,
		entries: [],
		compactions: [],
		forkState,
		updatedAt: new Date(),
	};
	let persistence = resolvePersistence(topContext, override);
	if (persistence) {
		await persistence.store.putThread(persistence.lease(), record);
	}
	let managed = buildManagedThread(topContext.chat, record);
	managed.untrackedAfterFork = untrackedAfterFork;
	state.threads.set(rootId, managed);
	return { managed, root: liveRoot };
}

/** Send thread summaries and top-level usage/compactions to a newly joined socket. */
export async function greetThreads(
	topContext: Chat.Room,
	ws: Socket,
	override?: ThreadPersistence,
): Promise<void> {
	if (topContext.rootChannelId) return;
	let state = await ensureLoaded(topContext, override);
	let summaries: Wire.ThreadSummary[] = [];
	for (let managed of state.threads.values()) {
		let summary = summarizeThread(
			managed.record.rootId,
			managed.record.forkedAt,
			managed.chat.entries.map(Chat.publicEntry),
		);
		if (summary.replyCount > 0) summaries.push(summary);
	}
	let compactions = topContext.chat.compactions;
	let usage = topContext.chat.usage;
	let compacting = topContext.chat.compacting;
	if (
		summaries.length === 0 && !usage && !compactions?.length && !compacting
	) {
		return;
	}
	tell(ws, {
		kind: "chat:threads",
		ts: 0,
		summaries,
		...(usage ? { usage } : {}),
		...(compactions?.length ? { compactions } : {}),
		...(compacting ? { compacting: true } : {}),
	});
}

/** Answer `chat:thread` for any viewer (or writer creating a thread fork). */
export async function openThread(
	topContext: Chat.Room,
	ws: Socket,
	frame: Request<Wire.OpenThread>,
	canCreate: boolean,
	override?: ThreadPersistence,
): Promise<void> {
	if (topContext.rootChannelId) {
		fail(ws, frame.rid, "this document's Chat is on its root document");
		return;
	}
	if (typeof frame.rootId !== "string" || !frame.rootId || frame.rootId.length > 128) {
		fail(ws, frame.rid, "invalid thread root id");
		return;
	}
	let state: ChannelThreads;
	try {
		state = await ensureLoaded(topContext, override);
	} catch (err) {
		console.error("[chat] could not load threads:", err);
		fail(ws, frame.rid, "could not open thread", PASSING);
		return;
	}
	let result: Awaited<ReturnType<typeof ensureThreadForRoot>>;
	try {
		result = await ensureThreadForRoot(
			topContext,
			state,
			frame.rootId,
			ws.data.handle,
			canCreate && frame.create === true,
			override,
		);
	} catch (err) {
		console.error("[chat] could not initialize thread:", err);
		fail(ws, frame.rid, "could not open thread", PASSING);
		return;
	}
	if (!result.root) {
		fail(ws, frame.rid, "thread root message was not found");
		return;
	}
	let managed = result.managed;
	let opened: Outgoing = {
		kind: "chat:thread",
		ts: 0,
		rootId: frame.rootId,
		root: result.root,
		forkedAt: managed?.record.forkedAt ?? nowSeconds(),
		entries: managed ? managed.chat.entries.map(Chat.publicEntry) : [],
		busy: managed?.chat.busy ?? false,
		...(managed?.chat.turn ? { turn: managed.chat.turn } : {}),
		...(managed?.chat.runs ? { runs: managed.chat.runs } : {}),
		...(managed?.chat.usage ? { usage: managed.chat.usage } : {}),
		...(managed?.chat.compactions?.length ? { compactions: managed.chat.compactions } : {}),
		...(managed?.chat.compacting ? { compacting: true } : {}),
	};
	reply(ws, frame.rid, opened);
}

/** Route `chat:send` to either top-level Chat or a forked thread, handling `alsoToChat`. */
/** Run a failed top-level turn again for its message; threads have no Retry. */
export async function retryMessage(
	topContext: Chat.Room,
	ws: Socket,
	msg: Request<Wire.Retry>,
	override?: ThreadPersistence,
): Promise<void> {
	let boundTop = bindTopLevel(topContext, override);
	await ensureLoaded(boundTop, override);
	await Chat.retry(boundTop, ws, msg);
}

export async function sendMessage(
	topContext: Chat.Room,
	ws: Socket,
	msg: Request<Wire.Send>,
	override?: ThreadPersistence,
): Promise<void> {
	let boundTop = bindTopLevel(topContext, override);
	if (msg.thread === undefined) {
		await ensureLoaded(boundTop, override);
		await Chat.send(boundTop, ws, msg);
		return;
	}
	if (typeof msg.thread !== "string" || !msg.thread || msg.thread.length > 128) {
		fail(ws, msg.rid, "invalid thread root id");
		return;
	}
	if (topContext.rootChannelId) {
		fail(ws, msg.rid, "this document's Chat is on its root document");
		return;
	}
	let state = await ensureLoaded(boundTop, override);
	let { managed } = await ensureThreadForRoot(
		boundTop,
		state,
		msg.thread,
		ws.data.handle,
		true,
		override,
	);
	if (!managed) {
		fail(ws, msg.rid, "thread root message was not found");
		return;
	}
	let beforeEntries = new Set(managed.chat.entries.map(entry => entry.id));
	let tRoom = buildThreadRoom(boundTop, managed, override);
	await Chat.send(tRoom, ws, msg);

	if (msg.alsoToChat === true) {
		let addedEntry = managed.chat.entries.find(
			entry => !beforeEntries.has(entry.id) && entry.author.kind === "member",
		);
		if (addedEntry) {
			await Chat.postAlsoToChat(boundTop, ws, {
				handle: ws.data.handle,
				text: addedEntry.text,
				references: addedEntry.references,
				focus: typeof msg.focus === "string" ? msg.focus : undefined,
			});
		}
	}
}

/** Route turn-control frames (`abort`, `resume`, run controls) for threads or top-level Chat. */
export async function controlMessage(
	topContext: Chat.Room,
	ws: Socket,
	frame:
		| Request<Wire.Abort>
		| Request<Wire.Resume>
		| Request<Wire.PauseRun>
		| Request<Wire.ResumeRun>,
	override?: ThreadPersistence,
): Promise<void> {
	let boundTop = bindTopLevel(topContext, override);
	if (frame.thread === undefined) {
		if (frame.kind === "chat:abort") await Chat.abort(boundTop, ws);
		else if (frame.kind === "chat:resume") await Chat.resume(boundTop, ws);
		else await Chat.controlRun(boundTop, ws, frame);
		return;
	}
	if (typeof frame.thread !== "string" || !frame.thread || frame.thread.length > 128) {
		fail(ws, frame.rid, "invalid thread root id");
		return;
	}
	let state = await ensureLoaded(boundTop, override);
	let managed = state.threads.get(frame.thread);
	if (!managed) {
		fail(ws, frame.rid, "thread was not found");
		return;
	}
	let tRoom = buildThreadRoom(boundTop, managed, override);
	if (frame.kind === "chat:abort") await Chat.abort(tRoom, ws);
	else if (frame.kind === "chat:resume") await Chat.resume(tRoom, ws);
	else await Chat.controlRun(tRoom, ws, frame);
}
