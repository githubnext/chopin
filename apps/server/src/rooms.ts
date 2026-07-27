/**
 * Rooms, and who is in them.
 *
 * A room comes into existence because somebody opened its URL. There is no
 * creation step and no registry to keep in sync — a name is enough, which is
 * what makes a link shareable with no setup at the other end.
 *
 * Only membership lives here. The collaborative document, its questionnaires
 * and the agent session attach to the same record as they arrive.
 */

import type { Identity, Socket } from "./wire";

export type Room = {
	id: string;
	/** Keyed by client id, so one person in two tabs is two members. */
	members: Map<string, Socket>;
};

const rooms = new Map<string, Room>();

/** GitHub handles, which is what an avatar URL will be built from. */
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Room names appear in a path and a directory name, so keep them boring. */
const ROOM = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validHandle(value: string): boolean {
	return HANDLE.test(value);
}

export function validRoom(value: string): boolean {
	return ROOM.test(value);
}

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
	room.members.set(ws.data.client, ws);
	return room;
}

/**
 * Remove a member, and the room with them if they were the last.
 *
 * Dropping an empty room is safe while membership is all it holds. Once a room
 * owns a document this becomes a snapshot followed by a delayed eviction, so
 * that a reload does not discard the thing being reloaded.
 */
export function leave(ws: Socket): Room | undefined {
	let room = rooms.get(ws.data.room);
	if (!room) return undefined;
	room.members.delete(ws.data.client);
	if (room.members.size === 0) rooms.delete(room.id);
	return room;
}

export function members(room: Room): Identity[] {
	return [...room.members.values()]
		.map(ws => ({ handle: ws.data.handle, client: ws.data.client }))
		.sort((a, b) => a.handle.localeCompare(b.handle) || a.client.localeCompare(b.client));
}
