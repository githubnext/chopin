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
import { toolbox } from "../agent/tools";
import * as Service from "../plan/service";
import { addressed } from "@chopin/protocol/address";

import { compose, remember } from "./address";
import { broadcast, tell } from "../wire";

import type { Server } from "bun";
import type { SessionEvent } from "@github/copilot-sdk";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { Plan } from "../plan/service";
import type { Said } from "./address";
import type { Socket, SocketData } from "../wire";

/** Beyond this the queue is a backlog nobody is going to read. */
const MAX_QUEUE = 20;

export type Chat = {
	entries: Wire.Entry[];
	waiting: Wire.Waiting[];
	/** The Copilot session, once somebody has prompted. */
	agent?: Agent.Agent;
	/** In flight while the session is being opened, so a second prompt waits. */
	opening?: Promise<Agent.Agent>;
	busy: boolean;
	/** Whose message the running turn is answering. */
	turn?: string;
	/** The entry the agent is currently writing into. */
	writing?: string;
	/** Detaches the event handler when a turn ends. */
	release?: () => void;
	/** When each running tool call started, for its duration. */
	timings: Map<string, number>;
	/** Session id, persisted so a restart resumes the conversation. */
	resume?: string;
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
	return { entries: [], waiting: [], busy: false, timings: new Map(), backscroll: [] };
}

/**
 * Come back with what was said before.
 *
 * An entry that was still streaming when the process went away never finished,
 * so the flag is cleared: it is as complete as it is ever going to be, and
 * leaving it set would show a spinner nothing will ever stop.
 */
export function restore(entries: Wire.Entry[], resume?: string): Chat {
	return {
		entries: entries.map(entry => {
			let { streaming: _streaming, ...rest } = entry;
			return rest;
		}),
		waiting: [],
		busy: false,
		timings: new Map(),
		backscroll: [],
		...(resume ? { resume } : {}),
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

function queued(chat: Chat, server: Server<SocketData>, room: string): void {
	broadcast(server, room, { kind: "chat:queue", ts: 0, waiting: chat.waiting });
}

function say(
	chat: Chat,
	server: Server<SocketData>,
	room: string,
	entry: Wire.Entry,
): Wire.Entry {
	chat.entries.push(entry);
	broadcast(server, room, { kind: "chat:message", ts: 0, entry });
	return entry;
}

/** Everything said so far, for somebody who has just arrived. */
export function greet(chat: Chat, ws: Socket): void {
	tell(ws, {
		kind: "chat:history",
		ts: 0,
		entries: chat.entries,
		busy: chat.busy,
		queued: chat.waiting,
	});
}

export type Room = {
	chat: Chat;
	plan: Plan;
	server: Server<SocketData>;
	room: string;
	config: Config;
};

/**
 * Take a message.
 *
 * It appears in the transcript either way — what somebody said is not
 * contingent on the agent being ready to hear it, or on it being for the agent
 * at all. What differs is whether it starts a turn.
 */
export function send(context: Room, ws: Socket, msg: Request<Wire.Send>): void {
	let text = msg.text.trim();
	if (!text) return;

	let { chat, room, server } = context;
	let handle = ws.data.handle;

	say(chat, server, room, {
		id: ulid(),
		author: { kind: "member", handle },
		text,
		ts: now(),
	});

	// Not for the agent: remembered, so the next turn arrives knowing it, but
	// nothing runs and nothing queues. Nobody asked for anything.
	if (!addressed(text)) {
		chat.backscroll = remember(chat.backscroll, { handle, text });
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
		chat.waiting.push({ id: ulid(), handle, text });
		return queued(chat, server, room);
	}

	void run(context, handle, text);
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

	await chat.agent.session.abort().catch(() => {});
	say(chat, server, room, {
		id: ulid(),
		author: { kind: "system" },
		text: `@${ws.data.handle} stopped the turn.`,
		ts: now(),
	});
}

async function session(context: Room): Promise<Agent.Agent> {
	let { chat, config, plan, room, server } = context;
	if (chat.agent) return chat.agent;

	// Captured before it is overwritten: the question is whether there *was* a
	// conversation to resume, not whether there is one now.
	let previous = chat.resume;

	return chat.opening ??= (async () => {
		let tools = toolbox({
			plan,
			server,
			room,
			publish: mutation => Service.publish(plan, server, room, mutation),
		});

		let { agent, resumed } = await Agent.open(config, { tools }, chat.resume);
		chat.agent = agent;
		chat.resume = agent.id;
		chat.opening = undefined;
		plan.sink.touch();

		// A transcript that survived while the conversation did not would
		// silently overstate what the agent remembers.
		if (previous && !resumed) {
			say(chat, server, room, {
				id: ulid(),
				author: { kind: "system" },
				text: "The previous conversation could not be resumed; the agent does not "
					+ "remember what is above this line.",
				ts: now(),
			});
		}

		return agent;
	})().catch(err => {
		chat.opening = undefined;
		throw err;
	});
}

/** Run one turn, then drain whatever queued up behind it. */
async function run(context: Room, handle: string, text: string): Promise<void> {
	let { chat, room, server } = context;

	chat.busy = true;
	chat.turn = handle;
	state(chat, server, room);

	try {
		let agent = await session(context);

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
	} catch (err) {
		console.error("[chat] turn failed:", err);
		say(chat, server, room, {
			id: ulid(),
			author: { kind: "system" },
			text: err instanceof Error ? err.message : "The agent could not be reached.",
			ts: now(),
		});
	} finally {
		chat.release?.();
		chat.release = undefined;
		chat.writing = undefined;
		chat.busy = false;
		chat.turn = undefined;
		state(chat, server, room);
	}

	let next = chat.waiting.shift();
	if (next) {
		queued(chat, server, room);
		await run(context, next.handle, next.text);
	}
}

/**
 * Turn what the SDK reports into what the room sees.
 *
 * Only the events a reader needs: what the agent said, what it is doing, and
 * when something failed. The rest is diagnostic noise that belongs in a log.
 */
function translate(context: Room, event: SessionEvent): void {
	let { chat, room, server } = context;

	switch (event.type) {
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
				return;
			}
			entry.text += deltaContent;
			broadcast(server, room, { kind: "chat:delta", ts: 0, id: messageId, text: deltaContent });
			return;
		}

		case "assistant.message": {
			let text = event.data.content;
			let entry = chat.entries.find(item => item.id === event.id);
			if (entry) {
				entry.text = text || entry.text;
				delete entry.streaming;
				broadcast(server, room, { kind: "chat:message", ts: 0, entry });
			} else if (text.trim()) {
				say(chat, server, room, {
					id: event.id,
					author: { kind: "agent" },
					text,
					ts: now(),
				});
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
				entry: attach(chat, activity),
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
				entry: attach(chat, activity),
				activity,
			});
			return;
		}

		case "session.error": {
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
function attach(chat: Chat, activity: Wire.Activity): string {
	let entry = chat.entries.find(item => item.id === chat.writing)
		?? chat.entries.findLast(item => item.author.kind === "agent");

	if (!entry) {
		entry = { id: ulid(), author: { kind: "agent" }, text: "", ts: now(), tools: [] };
		chat.entries.push(entry);
	}

	entry.tools ??= [];
	let existing = entry.tools.findIndex(item => item.id === activity.id);
	if (existing >= 0) entry.tools[existing] = { ...entry.tools[existing], ...activity };
	else entry.tools.push(activity);
	return entry.id;
}

/** Let go of the session. The conversation is resumable by id. */
export async function close(chat: Chat): Promise<void> {
	chat.release?.();
	await chat.agent?.session.disconnect().catch(() => {});
	chat.agent = undefined;
}
