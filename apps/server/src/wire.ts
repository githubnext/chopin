/**
 * Sending frames.
 *
 * Three shapes, because the distinction matters at every call site: a reply
 * goes to the one socket that asked and carries its `rid`; a relay goes to
 * everyone except the member who caused it, because they already know; a
 * broadcast goes to the whole room because the server decided something.
 *
 * Room membership is Bun's own pub/sub topic, so a relay is one call rather
 * than a loop over a set we would otherwise have to keep correct.
 */

import type { Server, ServerWebSocket } from "bun";
import type { Frame, Outgoing } from "@chopin/protocol";

export type Identity = {
	/** Verified GitHub login. */
	handle: string;
	/** Distinguishes two tabs belonging to the same handle. */
	client: string;
};

export type AuthorizationResult = "allowed" | "denied" | "unavailable";

export type SocketData = Identity & {
	room: string;
	channelTitle: string;
	channelSlug: string;
	channelUpdatedAt: string;
	channelArchivedAt?: string;
	canEdit: boolean;
	canManage: boolean;
	principalId: string;
	sessionId: string;
	authorizedUntil: number;
	credential: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	repositoryDefaultBranch: string;
	accessCheckedAt: number;
	authorizationTimer?: ReturnType<typeof setTimeout>;
	authorizationRefresh?: Promise<AuthorizationResult>;
	closed?: boolean;
};

export type Socket = ServerWebSocket<SocketData>;

/** Frames are addressed by room, so the topic is simply the room id. */
export function topic(room: string): string {
	return `room:${room}`;
}

function stamp<T extends Outgoing>(frame: T, extra?: Partial<Frame>): string {
	return JSON.stringify({ ...frame, ts: Math.floor(Date.now() / 1000), ...extra });
}

/** Answer one request, on the socket that made it. */
export function reply<T extends Outgoing>(ws: Socket, rid: string, frame: T): void {
	ws.send(stamp(frame, { rid }));
}

/** Refuse one request, on the socket that made it. */
export function fail(ws: Socket, rid: string, message: string): void {
	ws.send(stamp({ kind: "session:error", ts: 0, message }, { rid }));
}

/** Tell one socket something it did not ask for. */
export function tell<T extends Outgoing>(ws: Socket, frame: T): void {
	ws.send(stamp(frame));
}

/**
 * Tell the rest of the room what this member just did.
 *
 * Excludes the sender: they applied it locally before we heard about it, and
 * echoing it back is at best wasted bytes and at worst a second application.
 */
export function relay<T extends Outgoing>(ws: Socket, frame: T): void {
	ws.publish(topic(ws.data.room), stamp(frame, { sender: ws.data.handle }));
}

/** Tell the whole room something the server decided. */
export function broadcast<T extends Outgoing>(
	server: Server<SocketData>,
	room: string,
	frame: T,
): void {
	server.publish(topic(room), stamp(frame));
}
