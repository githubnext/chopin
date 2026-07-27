/**
 * The server.
 *
 * One process: the WebSocket every room talks over, and — in production — the
 * built client alongside it. In development Vite serves the client and proxies
 * `/ws` here, so the browser sees one origin either way and the client never
 * needs to know which mode it is in.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, load } from "./config";
import { uid } from "./ids";
import * as Rooms from "./rooms";
import { broadcast, relay, reply, tell, topic } from "./wire";

import type { Server } from "bun";
import type { Incoming } from "@chopin/protocol";
import type { Socket, SocketData } from "./wire";

const config = load();

/** Built client, when there is one. Absent during development. */
const CLIENT = join(import.meta.dir, "../../web/dist");

function presence(server: Server<SocketData>, room: Rooms.Room): void {
	broadcast(server, room.id, {
		kind: "session:presence",
		ts: 0,
		members: Rooms.members(room),
	});
}

/**
 * Decide whether a connection may be established.
 *
 * The key gates the socket rather than the page, because the page on its own
 * is inert: without a connection it holds no document, no transcript and no
 * way to reach the agent.
 */
function admit(url: URL): { data: SocketData } | { status: number; reason: string } {
	if (config.key && url.searchParams.get("key") !== config.key) {
		return { status: 403, reason: "access key required" };
	}

	let room = (url.searchParams.get("room") || "").toLowerCase();
	if (!Rooms.validRoom(room)) return { status: 400, reason: "bad room" };

	let handle = url.searchParams.get("as") || "";
	if (!Rooms.validHandle(handle)) return { status: 400, reason: "bad handle" };

	return { data: { room, handle, client: uid() } };
}

function receive(ws: Socket, raw: string): void {
	let frame: Incoming;
	try {
		frame = JSON.parse(raw) as Incoming;
	} catch {
		return;
	}

	switch (frame.kind) {
		case "session:ping":
			return reply(ws, frame.rid, { kind: "session:ping", ts: 0 });
	}
}

const server = Bun.serve<SocketData>({
	hostname: config.host,
	port: config.port,

	fetch(req, self) {
		let url = new URL(req.url);

		if (url.pathname === "/ws") {
			let outcome = admit(url);
			if ("status" in outcome) {
				return new Response(outcome.reason, { status: outcome.status });
			}
			if (self.upgrade(req, { data: outcome.data })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}

		if (!existsSync(CLIENT)) {
			return new Response("chopin server is running; start the client with `bun run dev`", {
				status: 404,
			});
		}

		// Everything that is not a real file is the single-page app, so a room
		// URL survives a reload.
		let file = Bun.file(join(CLIENT, url.pathname));
		return file.exists().then(found =>
			new Response(found ? file : Bun.file(join(CLIENT, "index.html")))
		);
	},

	websocket: {
		open(ws: Socket) {
			ws.subscribe(topic(ws.data.room));
			let room = Rooms.join(ws);
			tell(ws, {
				kind: "session:hello",
				ts: 0,
				room: room.id,
				you: { handle: ws.data.handle, client: ws.data.client },
				members: Rooms.members(room),
			});
			relay(ws, { kind: "session:presence", ts: 0, members: Rooms.members(room) });
		},

		message(ws: Socket, raw) {
			if (typeof raw === "string") receive(ws, raw);
		},

		close(ws: Socket) {
			let room = Rooms.leave(ws);
			ws.unsubscribe(topic(ws.data.room));
			if (room && room.members.size > 0) presence(server, room);
		},
	},
});

console.log(describe(config));
