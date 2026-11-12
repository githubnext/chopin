/**
 * Reactions made in a thread's view. A reply is the thread's message: its reaction is saved in the
 * thread's record and told as a `chat:in-thread` frame. The root is the Chat's message, shown at the
 * head of the thread: its reaction is saved and told as Chat's own, so its pills in Chat change too.
 * Either way a reaction the Planner answers is answered in the thread, by the thread's session.
 */
import type { Chat as Wire, Request } from "@chopin/protocol";

import { fail, PASSING } from "../wire";
import { respondInThread } from "./reaction-reply";
import { react } from "./reactions";
import { threadRoomFor } from "./threads";

import type { Socket } from "../wire";
import type { Room } from "./service";
import type { ThreadPersistence } from "./threads";

/**
 * The thread a Chat message belongs to when it is also that thread's (a reply sent to Chat too, and
 * the Planner's answer to it): its reactions are the thread's, wherever they are made.
 */
export function copiedFrom(top: Room, id: unknown): string | undefined {
	return top.chat.entries.find(entry => entry.id === id)?.fromThread;
}

export async function reactInThread(
	top: Room,
	ws: Socket,
	msg: Request<Wire.React>,
	override?: ThreadPersistence,
): Promise<void> {
	let rootId = msg.thread;
	if (typeof rootId !== "string" || !rootId || rootId.length > 128) {
		return fail(ws, msg.rid, "invalid thread root id");
	}
	if (top.rootChannelId) return fail(ws, msg.rid, "this document's Chat is on its root document");
	if (msg.id === rootId) {
		let handle = ws.data.handle;
		// The thread is started for the answer only if nobody has opened it to write in yet.
		let answerIn = () => threadRoomFor(top, rootId, handle, true, override);
		return react(top, ws, msg, reacted => respondInThread(top, top, reacted, { rootId, answerIn }));
	}
	let room: Room | undefined;
	try {
		room = await threadRoomFor(top, rootId, ws.data.handle, false, override);
	} catch (err) {
		console.error("[chat] could not load a thread:", err instanceof Error ? err.name : "unknown");
		return fail(ws, msg.rid, "could not save reaction", PASSING);
	}
	if (!room) return fail(ws, msg.rid, "thread was not found");
	// Who may have a reaction answered is the document's question, asked of its top-level room.
	let context: Room = {
		...room,
		initiativeAuthorize: top.initiativeAuthorize,
		reactionAuthorize: top.reactionAuthorize,
	};
	return react(context, ws, msg, reacted => respondInThread(top, context, reacted, { rootId }));
}
