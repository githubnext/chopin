import { afterEach, expect, test } from "bun:test";

import { linkAuth } from "../testing/planner-link";
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
	let sockets = new SessionSockets();
	linked.revocations.add(async id => sockets.revoke(id));
	let server = Bun.serve<SocketData | SidebarSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, self) {
			let url = new URL(request.url);
			let outcome = url.pathname === "/ws/sidebar"
				? await admitSidebar(request, auth)
				: await admit(request, url, auth);
			if ("status" in outcome) return new Response(outcome.reason, { status: outcome.status });
			return self.upgrade(request, { data: outcome.data })
				? undefined
				: new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				sockets.opened(ws);
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

	async function open(cookie: string, path: string) {
		let socket = new (WebSocket as unknown as HeaderWebSocket)(
			`ws://127.0.0.1:${server.port}${path}`,
			{ headers: { cookie, origin: ORIGIN } },
		);
		let frames: string[] = [];
		let closed = Promise.withResolvers<{ code: number; at: number }>();
		socket.addEventListener("message", event => frames.push(String(event.data)));
		socket.addEventListener("close", event => closed.resolve({ code: event.code, at: Date.now() }));
		cleanups.push(() => socket.close());
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("close", () => reject(new Error(`${path} was refused`)), {
				once: true,
			});
		});
		return { socket, frames, closed: closed.promise };
	}

	return {
		linked,
		signIn,
		room: (cookie: string) => open(cookie, `/ws?channel=${linked.channel.id}`),
		sidebar: (cookie: string) => open(cookie, "/ws/sidebar"),
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
