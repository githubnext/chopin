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
import * as Service from "./plan/service";
import * as Rooms from "./rooms";
import { broadcast, fail, relay, tell, topic } from "./wire";

import type { Server } from "bun";
import type { Incoming } from "@chopin/protocol";
import type { Socket, SocketData } from "./wire";

const config = load();

/** Built client, when there is one. Absent during development. */
const CLIENT = join(import.meta.dir, "../../web/dist");

/**
 * How long an empty room is kept before its document is released.
 *
 * A reload is a departure followed by an arrival, and discarding the document
 * in between would cost the epoch and everyone's undo history for a keypress.
 */
const EVICT_MS = 30_000;

function presence(server: Server<SocketData>, room: Rooms.Room): void {
	broadcast(server, room.id, {
		kind: "session:presence",
		ts: 0,
		members: Rooms.members(room),
	});
}

/**
 * Attach the document to a room, once.
 *
 * Two clients opening at the same moment must not build two documents, so the
 * first stores its promise and the second waits on it.
 */
function plan(room: Rooms.Room, server: Server<SocketData>): Promise<Service.Plan> {
	if (room.plan) return Promise.resolve(room.plan);
	return room.opening ??= Service
		.open(room.id, join(config.dataDir, room.id), server)
		.then(opened => {
			room.plan = opened;
			room.opening = undefined;
			return opened;
		})
		.catch(err => {
			room.opening = undefined;
			throw err;
		});
}

function evict(room: Rooms.Room): void {
	if (room.eviction || room.members.size > 0) return;
	room.eviction = setTimeout(() => {
		if (room.members.size > 0) return;
		let held = room.plan;
		Rooms.forget(room);
		if (held) void Service.close(held);
	}, EVICT_MS);
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

async function receive(ws: Socket, raw: string): Promise<void> {
	let frame: Incoming;
	try {
		frame = JSON.parse(raw) as Incoming;
	} catch {
		return;
	}

	let room = Rooms.get(ws.data.room);
	if (!room) return;

	switch (frame.kind) {
		case "session:ping":
			return tell(ws, { kind: "session:ping", ts: 0, rid: frame.rid });

		case "plan:open": {
			try {
				Service.greet(await plan(room, server), ws, frame);
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot open plan");
			}
			return;
		}

		case "plan:update":
			if (room.plan) Service.submit(room.plan, ws, frame);
			return;

		case "plan:awareness":
			if (room.plan) Service.awareness(room.plan, ws, frame);
			return;

		case "plan:close":
			if (room.plan) Service.departed(room.plan, ws);
			return;
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
			if (typeof raw === "string") void receive(ws, raw);
		},

		close(ws: Socket) {
			let room = Rooms.leave(ws);
			ws.unsubscribe(topic(ws.data.room));
			if (!room) return;
			if (room.plan) Service.departed(room.plan, ws);
			if (room.members.size > 0) presence(server, room);
			else evict(room);
		},
	},
});

/** Nothing in memory is worth losing to a Ctrl-C. */
async function drain(): Promise<void> {
	await Promise.all(Rooms.all().map(room => room.plan && Service.close(room.plan)));
	process.exit(0);
}

process.on("SIGINT", () => void drain());
process.on("SIGTERM", () => void drain());

console.log(describe(config));
