/**
 * Rooms, and who is in them.
 *
 * A runtime room comes into existence when an authenticated member opens a
 * durable channel. The channel catalog owns creation and authorization; this
 * module owns only active membership and eviction.
 *
 * Only membership lives here. The collaborative document, its questionnaires
 * and the agent session attach to the same record as they arrive.
 */

import type { Identity, Socket } from "./wire";
// Type-only: the plan attaches to a room, but a room knows nothing about how
// one is built, and a value import here would close a cycle.
import type { Plan } from "./plan/service";

export type Room = {
	id: string;
	/** Keyed by client id, so one person in two tabs is two members. */
	members: Map<string, Socket>;
	/**
	 * The collaborative document, attached on the first `plan:open`.
	 *
	 * Absent until somebody asks for it: a room that nobody has opened costs a
	 * map entry, not a Lexical editor and a Y.Doc.
	 */
	plan?: Plan;
	/** In flight while the first opener is building it, so the second waits. */
	opening?: Promise<Plan>;
	/** Final persistence is in flight; reopening waits for it to finish. */
	closing?: Promise<void>;
	/** Pending eviction, cancelled if somebody comes back. */
	eviction?: ReturnType<typeof setTimeout>;
};

const rooms = new Map<string, Room>();

function open(id: string): Room {
	let existing = rooms.get(id);
	if (existing) return existing;
	let created: Room = { id, members: new Map() };
	rooms.set(id, created);
	return created;
}

export function get(id: string): Room | undefined {
	return rooms.get(id);
}

export function join(ws: Socket): Room {
	let room = open(ws.data.room);
	// A reload is a departure followed by an arrival. Cancelling here is what
	// keeps the document alive across one.
	if (room.eviction) {
		clearTimeout(room.eviction);
		room.eviction = undefined;
	}
	room.members.set(ws.data.client, ws);
	return room;
}

export function leave(ws: Socket): Room | undefined {
	let room = rooms.get(ws.data.room);
	if (!room) return undefined;
	if (room.members.get(ws.data.client) === ws) room.members.delete(ws.data.client);
	return room;
}

/** Rooms currently in memory, for shutdown. */
export function all(): Room[] {
	return [...rooms.values()];
}

export function forget(room: Room): void {
	if (room.eviction) clearTimeout(room.eviction);
	if (rooms.get(room.id) === room) rooms.delete(room.id);
}

export function members(room: Room): Identity[] {
	return [...room.members.values()]
		.map(ws => ({ handle: ws.data.handle, client: ws.data.client }))
		.sort((a, b) => a.handle.localeCompare(b.handle) || a.client.localeCompare(b.client));
}
