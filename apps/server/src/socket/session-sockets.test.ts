import { afterEach, expect, test } from "bun:test";

import { linkAuth } from "../testing/agent-link";
import { admit, admitSidebar } from "./admission";
import { SESSION_ENDED, SessionSockets } from "./session-sockets";

import type { HostedAuth } from "../auth/routes";
import type { SidebarSocketData, SocketData } from "../wire";

const ORIGIN = "https://chopin.test";
const DAY_MS = 24 * 60 * 60 * 1_000;
const ROOM = "room";

/** Bun's WebSocket accepts request headers; the DOM declaration does not say so. */
type HeaderWebSocket = new(url: string, init: { headers: Record<string, string> }) => WebSocket;

let cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Room and sidebar sockets admitted and tracked as `main.ts` admits and tracks them. */
async function socketServer() {
	let linked = await linkAuth();
	let auth = linked.auth as unknown as HostedAuth;
	let sockets = new SessionSockets(id => linked.sessions.isLive(id));
	linked.revocations.add(async id => sockets.revoke(id));
	/** Released before a socket whose admission succeeded is upgraded; immediate unless paused. */
	let upgrading: Promise<void> = Promise.resolve();
	let server = Bun.serve<SocketData | SidebarSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, self) {
			let url = new URL(request.url);
			let outcome = url.pathname === "/ws/sidebar"
				? await admitSidebar(request, auth)
				: await admit(request, url, auth);
			if ("status" in outcome) return new Response(outcome.reason, { status: outcome.status });
			await upgrading;
			return self.upgrade(request, { data: outcome.data })
				? undefined
				: new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				if (!sockets.opened(ws)) return;
				ws.subscribe(ROOM);
			},
			message() {},
			close(ws) {
				sockets.closed(ws);
			},
		},
	});
	cleanups.push(() => server.stop(true));

	/** Sign `login` in to the browser at the logins' current time. */
	async function signIn(userId: string, login: string): Promise<string> {
		let issued = await linked.sessions.issue(userId, {
			accessToken: `${login}-browser-login`,
			accessExpiresIn: 28_800,
			refreshToken: "refresh-token",
			refreshExpiresIn: 86_400,
		});
		return issued.cookie.split(";")[0]!;
	}

	/** Start connecting; `opened` says whether the server upgraded the socket. */
	function connect(cookie: string, path: string) {
		let socket = new (WebSocket as unknown as HeaderWebSocket)(
			`ws://127.0.0.1:${server.port}${path}`,
			{ headers: { cookie, origin: ORIGIN } },
		);
		let frames: string[] = [];
		let closed = Promise.withResolvers<{ code: number; at: number }>();
		let opened = Promise.withResolvers<boolean>();
		socket.addEventListener("message", event => frames.push(String(event.data)));
		socket.addEventListener("open", () => opened.resolve(true), { once: true });
		socket.addEventListener("close", event => {
			opened.resolve(false);
			closed.resolve({ code: event.code, at: Date.now() });
		});
		cleanups.push(() => socket.close());
		return { socket, frames, closed: closed.promise, opened: opened.promise };
	}

	async function open(cookie: string, path: string) {
		let connecting = connect(cookie, path);
		if (!await connecting.opened) throw new Error(`${path} was refused`);
		return connecting;
	}

	/** Hold the next room admission inside its repository authorization until released. */
	function pauseAuthorization() {
		let github = auth.github as { repositoryAccess: (...args: any[]) => Promise<unknown> };
		let authorize = github.repositoryAccess;
		let reached = Promise.withResolvers<void>();
		let released = Promise.withResolvers<void>();
		github.repositoryAccess = async (...args) => {
			github.repositoryAccess = authorize;
			reached.resolve();
			await released.promise;
			return authorize(...args);
		};
		return { reached: reached.promise, release: () => released.resolve() };
	}

	/** Hold every admitted socket short of its upgrade until released. */
	function pauseUpgrades() {
		let released = Promise.withResolvers<void>();
		upgrading = released.promise;
		return () => {
			upgrading = Promise.resolve();
			released.resolve();
		};
	}

	return {
		linked,
		signIn,
		room: (cookie: string) => open(cookie, `/ws?channel=${linked.channel.id}`),
		sidebar: (cookie: string) => open(cookie, "/ws/sidebar"),
		connectRoom: (cookie: string) => connect(cookie, `/ws?channel=${linked.channel.id}`),
		connectSidebar: (cookie: string) => connect(cookie, "/ws/sidebar"),
		pauseAuthorization,
		pauseUpgrades,
		broadcast: (text: string) => server.publish(ROOM, text),
	};
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
	return Promise.race([
		promise,
		new Promise<"timed out">(resolve => setTimeout(() => resolve("timed out"), ms)),
	]);
}

test("signing out closes that login's room and sidebar sockets at once and leaves another login's open", async () => {
	let server = await socketServer();
	let member = await server.signIn("U_member", "member");
	let rival = await server.signIn("U_rival", "rival");
	let room = await server.room(member);
	let sidebar = await server.sidebar(member);
	let other = await server.room(rival);

	let signedOutAt = Date.now();
	await server.linked.sessions.revoke(new Request(`${ORIGIN}/`, { headers: { cookie: member } }));

	for (let socket of [room, sidebar]) {
		let closed = await within(socket.closed, 1_000);
		expect(closed).not.toBe("timed out");
		expect((closed as { code: number }).code).toBe(SESSION_ENDED);
		expect((closed as { at: number }).at - signedOutAt).toBeLessThan(1_000);
	}
	let heard = room.frames.length;
	server.broadcast("session:planner");
	await expect(within(other.closed, 200)).resolves.toBe("timed out");
	expect(other.socket.readyState).toBe(WebSocket.OPEN);
	await Bun.sleep(50);
	expect(other.frames).toContain("session:planner");
	expect(room.frames.slice(heard)).toEqual([]);
});

test("a login the expiry sweep removes closes its sockets and leaves a live login's open", async () => {
	let server = await socketServer();
	let member = await server.signIn("U_member", "member");
	let expiring = await server.room(member);
	server.linked.clock.skewMs = 29 * DAY_MS;
	let rival = await server.signIn("U_rival", "rival");
	let other = await server.room(rival);

	server.linked.clock.skewMs = 31 * DAY_MS;
	await server.linked.sessions.cleanupExpired();

	let closed = await within(expiring.closed, 1_000);
	expect(closed).not.toBe("timed out");
	expect((closed as { code: number }).code).toBe(SESSION_ENDED);
	await expect(within(other.closed, 200)).resolves.toBe("timed out");
	expect(other.socket.readyState).toBe(WebSocket.OPEN);
});

/** The ended login's socket never stays open and never hears the room. */
async function expectShut(
	server: Awaited<ReturnType<typeof socketServer>>,
	socket: ReturnType<Awaited<ReturnType<typeof socketServer>>["connectRoom"]>,
	other: Awaited<ReturnType<Awaited<ReturnType<typeof socketServer>>["room"]>>,
) {
	let closed = await within(socket.closed, 1_000);
	expect(closed).not.toBe("timed out");
	if (await socket.opened) expect((closed as { code: number }).code).toBe(SESSION_ENDED);
	server.broadcast("session:planner");
	await Bun.sleep(50);
	expect(other.frames).toContain("session:planner");
	expect(socket.frames).toEqual([]);
	expect(socket.socket.readyState).toBe(WebSocket.CLOSED);
}

test("a login that ends while its room socket's repository authorization is pending is never upgraded", async () => {
	let server = await socketServer();
	let member = await server.signIn("U_member", "member");
	let rival = await server.signIn("U_rival", "rival");
	let other = await server.room(rival);

	let paused = server.pauseAuthorization();
	let room = server.connectRoom(member);
	await paused.reached;
	await server.linked.sessions.revoke(new Request(`${ORIGIN}/`, { headers: { cookie: member } }));
	paused.release();

	expect(await within(room.opened, 1_000)).toBe(false);
	await expectShut(server, room, other);
});

test("a login that ends after its sockets are admitted but before they open closes them before they hear the room", async () => {
	let server = await socketServer();
	let member = await server.signIn("U_member", "member");
	let rival = await server.signIn("U_rival", "rival");
	let other = await server.room(rival);

	let release = server.pauseUpgrades();
	let room = server.connectRoom(member);
	let sidebar = server.connectSidebar(member);
	await Bun.sleep(100);
	await server.linked.sessions.revoke(new Request(`${ORIGIN}/`, { headers: { cookie: member } }));
	release();

	for (let socket of [room, sidebar]) {
		expect(await socket.opened).toBe(true);
		await expectShut(server, socket, other);
	}
});
