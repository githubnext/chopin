/**
 * The conversation.
 *
 * One transcript per room, shared by everyone in it, and one turn at a time.
 * Messages that address the agent are queued rather than refused while it is
 * working: the plan belongs to the agent for the length of a turn, but the
 * conversation does not, and silencing somebody because a colleague prompted
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

import { ulid } from "@chopin/dialect";

import * as Agent from "../agent/client";
import { repositoryTools } from "../agent/repository";
import { toolbox } from "../agent/tools";
import * as Service from "../plan/service";
import { instruction } from "@chopin/protocol/address";

import { compose, remember } from "./address";
import { broadcast, fail, tell } from "../wire";

import type { Server } from "bun";
import type { SessionEvent } from "@github/copilot-sdk";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { HostedAuth } from "../auth/routes";
import type { HostedRepository } from "../agent/repository";
import type { Plan } from "../plan/service";
import type { Said } from "./address";
import type { Socket, SocketData } from "../wire";

/** Beyond this the queue is a backlog nobody is going to read. */
const MAX_QUEUE = 20;

/** How long the agent's cursor stays where it finished, after a turn ends. */
const LINGER_MS = 5_000;
const CREDENTIAL_EXPIRY_SKEW_MS = 60_000;

/**
 * A queued message, with what the queue needs and clients do not.
 *
 * `spent` is asked, just before the turn would run, whether somebody else has
 * already done the work. It is a function rather than a flag because the answer
 * is only knowable at that moment — and `JSON.stringify` drops it, so the wire
 * shape stays exactly `Wire.Waiting`.
 */
type Waiting = Wire.Waiting & {
	spent?: () => boolean;
	/** True when this came from the composer rather than another instruction. */
	message?: boolean;
	/** The comment thread this turn was started to act on, if one was. */
	thread?: string;
	/** Login session whose Copilot entitlement owns this queued turn. */
	sessionId?: string;
};

/** What a turn other than a message needs to say about itself. */
export type Instruction = {
	spent?: () => boolean;
	thread?: string;
};

export type Chat = {
	entries: Wire.Entry[];
	waiting: Waiting[];
	/** The Copilot session, once somebody has prompted. */
	agent?: Agent.Agent;
	/** In flight while the session is being opened, so a second prompt waits. */
	opening?: Promise<Agent.Agent>;
	openingOwner?: { sessionId: string; generation: number; revision: number };
	/** Fences an SDK session that finishes opening after it was invalidated. */
	lifecycle: number;
	/** Complete top-level turn lifecycle, including queued turns. */
	running?: Promise<void>;
	closed: boolean;
	busy: boolean;
	/** The transient lifecycle of the running Planner turn. */
	turn?: Wire.Turn;
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
	/** Detaches the event handler when a turn ends. */
	release?: () => void;
	/** Ends a turn when reset destroys the SDK session before it emits idle. */
	finishTurn?: () => void;
	/** Pending removal of the agent's cursor, cancelled if it edits again. */
	lingering?: ReturnType<typeof setTimeout>;
	/** When each running tool call started, for its duration. */
	timings: Map<string, number>;
	/** First-invoker ownership, fenced by storage generation. */
	owner?: { sessionId: string; generation: number; revision: number; expiresAt: number };
	/** Stops a disposable SDK session shortly before its copied token expires. */
	credentialTimer?: ReturnType<typeof setTimeout>;
	/** User-facing reason an in-flight turn was interrupted. */
	interruption?: string;
	/** Durable context prepended once after recreating a hosted SDK session. */
	bootstrap?: string;
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
		busy: false,
		lifecycle: 0,
		closed: false,
		timings: new Map(),
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
		busy: false,
		lifecycle: 0,
		closed: false,
		timings: new Map(),
		backscroll: [],
	};
}

function now(): number {
	return Math.floor(Date.now() / 1000);
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
 * `spent` is a function and disappears on its own; `thread` is a string and
 * would not. Both are how the queue decides what to do, not anything a reader
 * of the transcript has business knowing.
 */
function visible(chat: Chat): Wire.Waiting[] {
	return chat.waiting.map(({ handle, id, text }) => ({ handle, id, text }));
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
	broadcast(server, room, { kind: "chat:message", ts: 0, entry });
}

/** Everything said so far, for somebody who has just arrived. */
export function greet(chat: Chat, ws: Socket): void {
	tell(ws, {
		kind: "chat:history",
		ts: 0,
		entries: chat.entries,
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
	persist: () => Promise<void>;
};

/**
 * Take a message.
 *
 * A room message appears immediately. A planner message queued behind another
 * turn stays visibly queued until that turn actually begins, then moves into
 * the transcript exactly once. The destination, rather than its prose, decides
 * which lifecycle it takes.
 */
export async function send(context: Room, ws: Socket, msg: Request<Wire.Send>): Promise<void> {
	let text = msg.text.trim();
	if (!text) return;

	let { chat, room, server } = context;
	if (chat.closed) return;
	let handle = ws.data.handle;
	let destination = msg.to;
	if (destination !== "room" && destination !== "planner") return;
	let visible = destination === "planner" ? instruction(text) : text;

	if (destination === "room") {
		let entry: Wire.Entry = {
			id: ulid(),
			author: { kind: "member", handle },
			text: visible,
			ts: now(),
		};
		chat.entries.push(entry);
		try {
			await context.persist();
		} catch {
			chat.entries = chat.entries.filter(value => value.id !== entry.id);
			return fail(ws, msg.rid, "could not save message");
		}
		announce(server, room, entry);
		chat.backscroll = remember(chat.backscroll, { handle, text: visible });
		return;
	}
	if (!context.config.agent) {
		let entries: Wire.Entry[] = [{
			id: ulid(),
			author: { kind: "member", handle },
			text: visible,
			ts: now(),
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
		for (let entry of entries) announce(server, room, entry);
		return;
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
			text: visible,
			message: true,
			sessionId: context.claimantSessionId,
		});
		return queued(chat, server, room);
	}

	let entry: Wire.Entry = {
		id: ulid(),
		author: { kind: "member", handle },
		text: visible,
		ts: now(),
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
	if (chat.closed) return;
	announce(server, room, entry);
	startRun(
		context,
		handle,
		visible,
		undefined,
		context.claimantSessionId,
		true,
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
	if (!chat.busy || !chat.agent) return;

	await Agent.abort(chat.agent);
	say(chat, server, room, {
		id: ulid(),
		author: { kind: "system" },
		text: `@${ws.data.handle} stopped the turn.`,
		ts: now(),
	});
}

function planTools(context: Room) {
	let { plan, room, server } = context;
	return toolbox({
		plan,
		server,
		room,
		publish: mutation => Service.publish(plan, server, room, mutation),
		persist: context.persist,
		exclusive: action => Service.exclusive(plan, action),
		anchors: () => Service.anchors(plan, server, room),
		changes: found => Service.changes(plan, server, room, found),
	});
}

function bootstrap(
	chat: Chat,
	cursor: number,
	summary: string,
	currentText: string,
): string | undefined {
	let start = Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= chat.entries.length
		? cursor
		: 0;
	let entries = chat.entries.slice(start);
	let last = entries.at(-1);
	if (last?.author.kind === "member" && last.text === currentText) entries = entries.slice(0, -1);
	entries = entries.slice(-100);
	if (entries.length === 0 && !summary) return undefined;
	let transcript = entries.map(entry => {
		let speaker = entry.author.kind === "member"
			? `@${entry.author.handle}`
			: entry.author.kind === "agent"
			? "Planner"
			: "System";
		return `${speaker}: ${entry.text}`;
	}).join("\n").slice(-50_000);
	return [
		"This Copilot session was recreated.",
		summary ? `Earlier durable summary:\n${summary}` : "",
		transcript ? `Durable conversation context follows:\n${transcript}` : "",
	].filter(Boolean).join("\n\n");
}

async function repositorySession(
	context: Room,
	claimantSessionId: string,
	currentText: string,
): Promise<Agent.Agent> {
	let { ownership, owner, repository } = await resolveOwner(
		context.auth,
		context.repository,
		context.room,
		claimantSessionId,
	);
	let { auth } = context;
	let ownerSessionId = ownership.ownerSessionId!;
	let credentialExpiresAt = Math.min(
		owner.access.expiresAt.getTime(),
		owner.session.expiresAt.getTime(),
	);

	let { chat } = context;
	let lifecycle = chat.lifecycle;
	let reusable = chat.agent;
	let binding = chat.owner;
	let reuseLifecycle = chat.lifecycle;
	if (
		reusable
		&& binding?.sessionId === ownerSessionId
		&& binding.generation === ownership.generation
		&& binding.revision === owner.access.revision
		&& binding.expiresAt > Date.now() + CREDENTIAL_EXPIRY_SKEW_MS
	) {
		await auth.storage.channels.updateAgentContext({
			channelId: context.room,
			ownerSessionId,
			generation: ownership.generation,
			summary: ownership.summary,
			transcriptCursor: ownership.transcriptCursor,
			status: "ready",
			now: new Date(),
		});
		if (
			chat.lifecycle !== reuseLifecycle
			|| chat.agent !== reusable
			|| chat.owner !== binding
		) throw new Error("The Planner session changed while it was being reused. Try again.");
		return reusable;
	}
	if (chat.agent) await Agent.discard(chat.agent);
	chat.agent = undefined;
	chat.owner = undefined;
	clearTimeout(chat.credentialTimer);
	chat.credentialTimer = undefined;
	let activeOwner = await auth.sessions.inspect(ownerSessionId);
	if (chat.lifecycle !== lifecycle || activeOwner?.access.revision !== owner.access.revision) {
		throw new Error(
			"The Planner credentials changed while its old session was closing. Try again.",
		);
	}
	owner = activeOwner;
	credentialExpiresAt = Math.min(
		owner.access.expiresAt.getTime(),
		owner.session.expiresAt.getTime(),
	);
	if (credentialExpiresAt <= Date.now() + CREDENTIAL_EXPIRY_SKEW_MS) {
		throw new Error("The Copilot owner's login session is about to expire. Sign in again.");
	}
	let openingOwner = {
		sessionId: ownerSessionId,
		generation: ownership.generation,
		revision: owner.access.revision,
	};
	chat.openingOwner = openingOwner;
	let bound = () =>
		chat.lifecycle === lifecycle
		&& (chat.openingOwner === openingOwner
			|| (chat.owner?.sessionId === ownerSessionId
				&& chat.owner.generation === ownership.generation
				&& chat.owner.revision === owner.access.revision));
	let activeToken = () => {
		if (!bound()) return undefined;
		return auth.sessions.token(ownerSessionId, owner.access.revision);
	};
	let tools = [
		...planTools(context),
		...repositoryTools({ token: activeToken, repository }),
	];
	let opening: Promise<Agent.Agent> | undefined;
	let opened: Agent.Agent | undefined;
	try {
		opening = Agent.openPlanner(context.config, { tools }, {
			token: owner.access.token,
			repository,
			bootstrap: bootstrap(chat, ownership.transcriptCursor, ownership.summary, currentText),
			authorize: async () => {
				if (!bound()) return false;
				let activeOwner = await auth.sessions.inspect(ownerSessionId);
				if (!activeOwner || activeOwner.access.revision !== owner.access.revision) return false;
				if (!await auth.admission.allowed(activeOwner.access.token, activeOwner.user.id)) {
					return false;
				}
				let stored = await auth.storage.collaboration.load(context.room, new Date());
				if (
					stored?.agent?.ownerSessionId !== ownerSessionId
					|| stored.agent.generation !== ownership.generation
				) return false;
				let access = await auth.github.repositoryAccess(
					activeOwner.access.token,
					repository.owner,
					repository.name,
				);
				let stillActive = await auth.sessions.inspect(ownerSessionId);
				return bound()
					&& stillActive?.access.revision === owner.access.revision
					&& !!access && access.id === repository.id
					&& (access.permissions.push || access.permissions.admin);
			},
		});
		chat.opening = opening;
		let agent = opened = await opening;
		let activeOwner = await auth.sessions.inspect(ownerSessionId);
		let activeOwnership = await auth.storage.collaboration.load(context.room, new Date());
		if (
			chat.lifecycle !== lifecycle
			|| chat.openingOwner !== openingOwner
			|| activeOwner?.access.revision !== owner.access.revision
			|| activeOwnership?.agent?.ownerSessionId !== ownerSessionId
			|| activeOwnership.agent.generation !== ownership.generation
		) {
			throw new Error("The Planner session changed while it was opening. Try again.");
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
		activeOwner = await auth.sessions.inspect(ownerSessionId);
		if (
			chat.lifecycle !== lifecycle
			|| chat.openingOwner !== openingOwner
			|| activeOwner?.access.revision !== owner.access.revision
		) {
			throw new Error("The Planner session changed while it was opening. Try again.");
		}
		chat.agent = agent;
		chat.owner = {
			sessionId: ownerSessionId,
			generation: ownership.generation,
			revision: owner.access.revision,
			expiresAt: credentialExpiresAt,
		};
		chat.credentialTimer = setTimeout(() => {
			void resetAgent(
				chat,
				ownerSessionId,
				owner.access.revision,
				"GitHub credentials expired, so the Planner session was restarted. Ask it to continue.",
			);
		}, Math.max(0, credentialExpiresAt - Date.now() - CREDENTIAL_EXPIRY_SKEW_MS));
		return agent;
	} catch (err) {
		if (opened && chat.agent !== opened) await Agent.discard(opened);
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
		if (chat.opening === opening) chat.opening = undefined;
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

async function session(
	context: Room,
	claimantSessionId: string,
	currentText: string,
): Promise<Agent.Agent> {
	return repositorySession(context, claimantSessionId, currentText);
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
		broadcast(server, room, { kind: "chat:message", ts: 0, entry });
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
): Promise<void> {
	let { chat, plan, room, server } = context;
	if (chat.closed) return;

	if (!reserved) {
		chat.busy = true;
		chat.turn = { id: ulid(), handle, started: now(), responded: false };
		chat.acting = thread;
		state(chat, server, room);
	} else chat.acting = thread;

	try {
		let agent = await session(context, claimantSessionId, text);
		if (chat.agent !== agent) {
			throw new Error("The Planner session changed before the turn started. Try again.");
		}

		/*
		 * `send` resolves when the message is accepted, not when the turn is
		 * over — the work happens afterwards, over events. Waiting on `send`
		 * alone tears the handler down before the agent has said anything.
		 *
		 * `session.idle` is the turn actually ending. `session.error` resolves
		 * it too: a turn that has failed is not going to reach idle, and
		 * leaving the room busy forever is worse than ending early.
		 */
		let finished = Promise.withResolvers<void>();
		chat.finishTurn = finished.resolve;
		chat.release = agent.session.on(event => {
			translate(context, event);
			if (event.type === "session.idle" || event.type === "session.error") {
				finished.resolve();
			}
		});

		// Drained rather than copied: what the agent has been told once should
		// not arrive again on the next turn.
		let prompt = compose(chat.backscroll, handle, text);
		chat.backscroll = [];

		// The handle travels to the model, because a position belongs to
		// whoever holds it.
		await agent.session.send({ prompt });
		await finished.promise;
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
		chat.release?.();
		chat.release = undefined;
		chat.finishTurn = undefined;
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
): void {
	if (context.chat.closed) return;
	let running = run(context, handle, text, thread, claimantSessionId, reserved);
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
		chat.entries.push({
			id: next.id,
			author: { kind: "member", handle: next.handle },
			text: next.text,
			ts: now(),
		});
	}
	return next;
}

/**
 * Turn what the SDK reports into what the room sees.
 *
 * Only the events a reader needs: what the agent said, what it is doing, and
 * when something failed. The rest is diagnostic noise that belongs in a log.
 *
 * Exported so it can be driven with synthetic events. Every field it reads
 * lives under `event.data` and several are near-homonyms of fields on the
 * envelope, which is the kind of mistake that produces plausible-looking
 * output rather than an error.
 */
export function translate(context: Room, event: SessionEvent): void {
	let { chat, room, server } = context;

	switch (event.type) {
		case "session.idle":
			chat.tooling = undefined;
			return;

		// One entry per assistant message, identified by the id the deltas
		// carry, so two messages in a turn do not run together.
		case "assistant.message_delta": {
			let { deltaContent, messageId } = event.data;
			let entry = chat.entries.find(item => item.id === messageId);
			if (!entry) {
				chat.writing = messageId;
				say(chat, server, room, {
					id: messageId,
					author: { kind: "agent" },
					text: deltaContent,
					ts: now(),
					streaming: true,
				});
				responded(chat, server, room, deltaContent);
				return;
			}
			entry.text += deltaContent;
			broadcast(server, room, { kind: "chat:delta", ts: 0, id: messageId, text: deltaContent });
			responded(chat, server, room, deltaContent);
			return;
		}

		case "assistant.message": {
			// `data.messageId`, not `event.id`. The envelope's id belongs to the
			// event; the message has its own, and it is the one the deltas were
			// keyed by. Looking up the wrong one finds nothing, appends a second
			// copy of the message, and leaves the first one streaming forever.
			let { content, messageId } = event.data;
			let entry = chat.entries.find(item => item.id === messageId);

			if (entry) {
				entry.text = content || entry.text;
				delete entry.streaming;
				broadcast(server, room, { kind: "chat:message", ts: 0, entry });
				responded(chat, server, room, content);
			} else if (content.trim()) {
				// No deltas arrived — a short reply the model did not stream.
				say(chat, server, room, {
					id: messageId,
					author: { kind: "agent" },
					text: content,
					ts: now(),
				});
				responded(chat, server, room, content);
			}

			chat.writing = undefined;
			return;
		}

		case "tool.execution_start": {
			let { arguments: args, toolCallId, toolName } = event.data;
			chat.timings.set(toolCallId, Date.now());
			let activity: Wire.Activity = {
				id: toolCallId,
				name: toolName,
				status: "running",
				...(args ? { args: JSON.stringify(args, null, 2) } : {}),
			};
			broadcast(server, room, {
				kind: "chat:tool",
				ts: 0,
				entry: attach(context, activity),
				activity,
			});
			return;
		}

		case "tool.execution_complete": {
			let { error, result, success, toolCallId } = event.data;
			let started = chat.timings.get(toolCallId);
			chat.timings.delete(toolCallId);

			let detail = result?.content ?? (error ? JSON.stringify(error) : undefined);
			// The completion does not repeat the tool's name; the start did, and
			// the entry it was filed under still has it.
			let activity: Wire.Activity = {
				id: toolCallId,
				name: named(chat, toolCallId),
				status: success ? "done" : "failed",
				...(started ? { took: Date.now() - started } : {}),
				// Bounded: a `grep` across a repository is not a thing anybody
				// wants delivered to every browser in the room.
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

		/*
		 * A refused tool never executes, so it produces no start and no
		 * completion — without this it leaves no trace at all, and the agent
		 * quietly works around a boundary nobody can see it hitting. Which is
		 * indistinguishable, from the outside, from a tool it never had.
		 */
		case "permission.completed": {
			let { result, toolCallId } = event.data;
			if (!toolCallId || !result.kind.startsWith("denied")) return;

			let feedback = "feedback" in result && typeof result.feedback === "string"
				? result.feedback
				: undefined;

			let activity: Wire.Activity = {
				id: toolCallId,
				name: named(chat, toolCallId),
				status: "failed",
				result: feedback ?? "Refused.",
			};
			broadcast(server, room, {
				kind: "chat:tool",
				ts: 0,
				entry: attach(context, activity),
				activity,
			});
			return;
		}

		case "session.error": {
			chat.tooling = undefined;
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: event.data.message || "The agent stopped unexpectedly.",
				ts: now(),
			});
			return;
		}
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
	clearTimeout(chat.credentialTimer);
	chat.credentialTimer = undefined;
	if (reason && chat.finishTurn) chat.interruption = reason;
	let agent = chat.agent;
	let opening = chat.opening;
	chat.agent = undefined;
	chat.owner = undefined;
	chat.opening = undefined;
	chat.openingOwner = undefined;
	if (agent) await Agent.abort(agent);
	chat.finishTurn?.();
	chat.release?.();
	chat.release = undefined;
	chat.finishTurn = undefined;
	if (agent) await Agent.discard(agent);
	if (opening) {
		let opened = await Agent.settle(opening);
		if (opened && opened !== agent) await Agent.discard(opened);
	}
}

/** Let go of the session. The conversation is resumable by id. */
export async function close(chat: Chat): Promise<void> {
	chat.closed = true;
	chat.lifecycle++;
	chat.waiting = [];
	let running = chat.running;
	let agent = chat.agent;
	let opening = chat.opening;
	chat.agent = undefined;
	chat.owner = undefined;
	chat.opening = undefined;
	chat.openingOwner = undefined;
	if (agent) await Agent.abort(agent);
	chat.finishTurn?.();
	chat.release?.();
	chat.release = undefined;
	chat.finishTurn = undefined;
	// A cursor waiting to be taken down has nowhere to be taken down from, and
	// a live timer would hold the loop open for its whole linger.
	clearTimeout(chat.lingering);
	chat.lingering = undefined;
	clearTimeout(chat.credentialTimer);
	chat.credentialTimer = undefined;
	if (agent) await Agent.discard(agent);
	if (opening) {
		let opened = await Agent.settle(opening);
		if (opened && opened !== agent) await Agent.discard(opened);
	}
	await running;
}
