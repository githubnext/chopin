/**
 * The server.
 *
 * One process: the WebSocket every room talks over, and — in production — the
 * built client alongside it. In development Vite serves the client and proxies
 * `/ws` here, so the browser sees one origin either way and the client never
 * needs to know which mode it is in.
 */

import { join } from "node:path";

import * as Agent from "./agent/client";
import * as Chat from "./chat/service";
import { proxy, serve } from "./client";
import { describe, load } from "./config";
import { uid } from "./ids";
import * as Service from "./plan/service";
import * as Inject from "./questions/inject";
import * as Questions from "./questions/service";
import * as Rooms from "./rooms";
import { broadcast, fail, relay, tell, topic } from "./wire";

import type { Server } from "bun";
import type { Incoming } from "@chopin/protocol";
import type { Socket, SocketData } from "./wire";

const config = load();

/** Where the built client lands. Used only when there is no dev client. */
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
			if (Inject.enabled()) Inject.ask(opened, server, room.id);
			return opened;
		})
		.catch(err => {
			room.opening = undefined;
			throw err;
		});
}

/** A room's conversation, with everything it needs to run a turn. */
function conversation(room: Rooms.Room): Chat.Room {
	return { chat: room.plan!.chat, plan: room.plan!, server, room: room.id, config };
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
				let opened = await plan(room, server);
				Service.greet(opened, ws, frame);
				// Anything still unanswered, so a joiner sees the sidecar the
				// others are already looking at, and everything said so far.
				Questions.greet(opened, ws);
				Chat.greet(opened.chat, ws);
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

		case "chat:send":
			if (room.plan && config.agent) Chat.send(conversation(room), ws, frame);
			return;

		case "chat:abort":
			if (room.plan) await Chat.abort(conversation(room), ws);
			return;

		case "chat:unqueue":
			if (room.plan) Chat.unqueue(conversation(room), ws, frame);
			return;

		case "question:open":
			if (room.plan) Questions.open(room.plan, ws, frame);
			return;

		case "question:edit":
			if (room.plan) Questions.edit(room.plan, ws, frame);
			return;

		case "question:presence":
			if (room.plan) Questions.focus(room.plan, ws, frame);
			return;

		case "question:submit":
			if (room.plan) await Questions.submit(room.plan, server, room.id, ws, frame);
			return;

		case "question:cancel":
			if (room.plan) await Questions.cancel(room.plan, server, room.id, ws, frame);
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

		return config.devClient ? proxy(req, url, config.devClient) : serve(url, CLIENT);
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
			if (room.plan) {
				Service.departed(room.plan, ws);
				Questions.away(room.plan, ws);
			}
			if (room.members.size > 0) presence(server, room);
			else evict(room);
		},
	},
});

/** Nothing in memory is worth losing to a Ctrl-C. */
async function drain(): Promise<void> {
	await Promise.all(Rooms.all().map(room => room.plan && Service.close(room.plan)));
	await Agent.shutdown();
	process.exit(0);
}

process.on("SIGINT", () => void drain());
process.on("SIGTERM", () => void drain());

/**
 * Refuse to start rather than start half-working.
 *
 * The agent is most of what this is for, and the ways it fails — no token, a
 * token Copilot will not accept, no binary for this platform — are all
 * detectable in a couple of seconds by trying. Discovering them when somebody
 * types their first message is worse for everyone.
 */
if (config.agent) {
	if (!config.token) {
		console.error("chopin: GITHUB_TOKEN is not set. Set one, or start with AGENT=off.");
		process.exit(1);
	}

	try {
		await Agent.probe(config, { tools: [] });
	} catch (err) {
		let reason = err instanceof Error ? err.message : String(err);
		console.error(`chopin: the agent could not start — ${reason}`);
		process.exit(1);
	}
}

console.log(describe(config));
