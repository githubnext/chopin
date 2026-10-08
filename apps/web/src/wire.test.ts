/**
 * What the connection says about itself.
 *
 * The failure this guards against was visible but silent: the header reported
 * a connection that had been thrown away, while a live socket sat behind it.
 * Status is the only account a user gets of why the editor will not accept
 * typing, so it being wrong is worse than it being absent.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { Wire } from "./wire";

import type { Server, ServerWebSocket } from "bun";
import type { Status } from "./wire";

let servers: Array<Server<undefined>> = [];
let wires: Wire[] = [];

afterEach(() => {
	for (let wire of wires) wire.dispose();
	wires = [];
	for (let server of servers) server.stop(true);
	servers = [];
});

/** A socket endpoint that accepts anything, or refuses everything. */
function endpoint(accept: boolean): number {
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, self) {
			if (!accept) return new Response("nope", { status: 403 });
			return self.upgrade(req) ? undefined : new Response("no", { status: 400 });
		},
		websocket: { message() {} },
	});
	servers.push(server);
	return server.port!;
}

function unavailable(): number {
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("try again", { status: 503 }),
	});
	servers.push(server);
	return server.port!;
}

function unauthorized(): number {
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("authentication required", { status: 401 }),
	});
	servers.push(server);
	return server.port!;
}

function restartable(): { port: number; deny: () => void; drop: () => void } {
	let denied = false;
	let sockets = new Set<ServerWebSocket<undefined>>();
	let server = Bun.serve<undefined>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, self) {
			if (req.headers.get("x-chopin-socket-probe") === "1") {
				return new Response(null, { status: denied ? 401 : 204 });
			}
			if (denied) return new Response("authentication required", { status: 401 });
			return self.upgrade(req) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			open: socket => {
				sockets.add(socket);
			},
			close: socket => {
				sockets.delete(socket);
			},
			message() {},
		},
	});
	servers.push(server);
	return {
		port: server.port!,
		drop: () => {
			for (let socket of sockets) socket.terminate();
		},
		deny: () => {
			denied = true;
			for (let socket of sockets) socket.terminate();
		},
	};
}

function deleted(mode: "frame" | "close"): { port: number; connections: () => number } {
	let connections = 0;
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, self) {
			if (req.headers.get("x-chopin-socket-probe") === "1") {
				return new Response(null, { status: 204 });
			}
			return self.upgrade(req) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			open(socket) {
				connections++;
				if (mode === "frame") {
					socket.send(JSON.stringify({ kind: "session:deleted", ts: 1 }));
				} else socket.close(4404, "deleted");
			},
			message() {},
		},
	});
	servers.push(server);
	return { port: server.port!, connections: () => connections };
}

function connect(
	port: number,
	seen: Status[],
	onAuthenticationRequired?: () => void,
	onDeleted?: () => void,
): Wire {
	// `location` is what the client derives its URL from, and there is none in
	// a test runtime.
	globalThis.location = { href: `http://127.0.0.1:${port}/`, protocol: "http:" } as Location;
	let wire = new Wire({
		channelId: "019c1234-1234-4123-8123-123456789abc",
		onAuthenticationRequired,
		onDeleted,
		onStatus: status => seen.push(status),
	});
	wires.push(wire);
	return wire;
}

async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("status", () => {
	it("announces itself on construction", async () => {
		let seen: Status[] = [];
		connect(endpoint(true), seen);

		await until(() => seen.includes("connected"), "connected");
		expect(seen[0]).toBe("connecting");
	});

	/**
	 * The regression. A discarded instance reports `closed`; a replacement must
	 * overwrite that immediately rather than waiting until it happens to reach
	 * some other state — which, if its socket never opens, is never.
	 */
	it("does not leave a discarded connection's state as the last word", async () => {
		let port = endpoint(true);
		let seen: Status[] = [];

		let first = connect(port, seen);
		await until(() => seen.includes("connected"), "first connected");
		first.dispose();
		expect(seen.at(-1)).toBe("closed");

		connect(port, seen);
		// Before the replacement can possibly have opened.
		expect(seen.at(-1)).toBe("connecting");
	});

	it("reports why a refused connection was refused", async () => {
		let seen: Status[] = [];
		let wire = connect(endpoint(false), seen);

		await until(() => wire.status === "denied", "denied");
		expect(seen).toContain("denied");
	});

	it("retries a temporarily unavailable admission", async () => {
		let seen: Status[] = [];
		let wire = connect(unavailable(), seen);

		await until(() => wire.status === "reconnecting", "reconnecting");
		expect(seen).not.toContain("denied");
	});

	it("requests reauthentication after a 401 admission", async () => {
		let seen: Status[] = [];
		let required = 0;
		let wire = connect(unauthorized(), seen, () => required++);

		await until(() => wire.status === "denied", "denied");
		expect(required).toBe(1);
	});

	it("requests reauthentication when a connected server loses its session", async () => {
		let service = restartable();
		let seen: Status[] = [];
		let required = 0;
		let wire = connect(service.port, seen, () => required++);
		await until(() => wire.status === "connected", "connected");

		service.deny();
		await until(() => required === 1, "reauthentication");
		expect(wire.status).toBe("denied");
	});

	it("reconnects after a transient socket loss with a valid session", async () => {
		let service = restartable();
		let seen: Status[] = [];
		let wire = connect(service.port, seen);
		await until(() => wire.status === "connected", "connected");
		let connections = seen.filter(status => status === "connected").length;

		service.drop();
		await until(
			() => seen.filter(status => status === "connected").length > connections,
			"reconnected",
		);
		expect(wire.status).toBe("connected");
	});

	it("reconnects immediately without leaving a second backoff attempt", async () => {
		let service = restartable();
		let seen: Status[] = [];
		let wire = connect(service.port, seen);
		await until(() => wire.status === "connected", "connected");
		service.drop();
		await until(() => wire.status === "reconnecting", "backoff");
		wire.reconnect();
		await until(() => wire.status === "connected", "manual reconnect");
		await Bun.sleep(500);
		expect(seen.filter(status => status === "connected")).toHaveLength(2);
		wire.dispose();
		wire.reconnect();
		expect(wire.status).toBe("closed");
	});

	it("skips the backoff when the network comes back", async () => {
		let service = restartable();
		let seen: Status[] = [];
		let wire = connect(service.port, seen);
		await until(() => wire.status === "connected", "connected");
		// A wake while connected is not a reason to reconnect.
		dispatchEvent(new Event("focus"));
		await Bun.sleep(50);
		expect(seen.filter(status => status === "connected")).toHaveLength(1);

		let random = Math.random;
		Math.random = () => 100;
		try {
			service.drop();
			await until(() => wire.status === "reconnecting", "backoff");
			let woken = Date.now();
			dispatchEvent(new Event("online"));
			await until(() => wire.status === "connected", "woken reconnect");
			// Well before the attempt the backoff would otherwise make at 1.2 s.
			expect(Date.now() - woken).toBeLessThan(500);
		} finally {
			Math.random = random;
		}
		await Bun.sleep(100);
		expect(seen.filter(status => status === "connected")).toHaveLength(2);
	});

	it("lands an attempt inside the grace period however long the backoff", async () => {
		let service = restartable();
		let seen: Status[] = [];
		let wire = connect(service.port, seen);
		await until(() => wire.status === "connected", "connected");

		let random = Math.random;
		Math.random = () => 100;
		try {
			let lost = Date.now();
			service.drop();
			await until(() => seen.filter(status => status === "connected").length === 2, "rescued");
			expect(Date.now() - lost).toBeLessThan(1500);
		} finally {
			Math.random = random;
		}
	});

	it("does not turn a burst of focus events into a burst of attempts", async () => {
		let attempts = 0;
		let server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				if (request.headers.get("x-chopin-socket-probe") !== "1") attempts++;
				return new Response("try again", { status: 503 });
			},
		});
		servers.push(server);
		let wire = connect(server.port!, []);
		await until(() => wire.status === "reconnecting", "backoff");

		let random = Math.random;
		Math.random = () => 100;
		try {
			let before = attempts;
			for (let i = 0; i < 30; i++) {
				dispatchEvent(new Event(i % 2 ? "focus" : "visibilitychange"));
				await Bun.sleep(100);
			}
			// One per second at most, where every event used to start one.
			expect(attempts - before).toBeLessThanOrEqual(4);
		} finally {
			Math.random = random;
		}
	}, 10_000);

	it("starts the backoff over when asked to reconnect", async () => {
		let attempts = 0;
		let server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				if (request.headers.get("x-chopin-socket-probe") !== "1") attempts++;
				return new Response("try again", { status: 503 });
			},
		});
		servers.push(server);
		let random = Math.random;
		Math.random = () => 0.999;
		try {
			let wire = connect(server.port!, []);
			await until(() => wire.status === "reconnecting", "backoff");
			// Each failed ask would otherwise double the wait after it.
			for (let i = 0; i < 5; i++) {
				let before = attempts;
				wire.reconnect();
				await until(() => attempts > before, "asked attempt");
				await Bun.sleep(50);
			}
			let before = attempts;
			await until(() => attempts > before, "automatic attempt soon after");
		} finally {
			Math.random = random;
		}
	});

	it("ignores a superseded refusal probe after manual reconnection", async () => {
		let probe = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let socket: ServerWebSocket<undefined> | undefined;
		let server = Bun.serve<undefined>({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request, self) {
				if (request.headers.get("x-chopin-socket-probe") === "1") {
					probe.resolve();
					await release.promise;
					return new Response("stale refusal", { status: 401 });
				}
				return self.upgrade(request) ? undefined : new Response("no", { status: 400 });
			},
			websocket: {
				open: current => {
					socket = current;
				},
				message() {},
			},
		});
		servers.push(server);
		let seen: Status[] = [];
		let required = 0;
		let wire = connect(server.port!, seen, () => required++);
		await until(() => wire.status === "connected", "connected");
		socket!.terminate();
		await probe.promise;
		wire.reconnect();
		await until(() => wire.status === "connected", "manual reconnect");
		release.resolve();
		await Bun.sleep(30);
		expect(wire.status).toBe("connected");
		expect(required).toBe(0);
	});

	for (let mode of ["frame", "close"] as const) {
		it(`treats a deleted ${mode} as terminal`, async () => {
			let service = deleted(mode);
			let seen: Status[] = [];
			let notifications = 0;
			let wire = connect(service.port, seen, undefined, () => notifications++);

			await until(() => wire.status === "deleted", "deleted");
			await Bun.sleep(800);

			expect(notifications).toBe(1);
			expect(service.connections()).toBe(1);
			expect(seen.at(-1)).toBe("deleted");
		});
	}

	it("rejects a pending request when the connection goes away", async () => {
		let port = endpoint(true);
		let seen: Status[] = [];
		let wire = connect(port, seen);
		await until(() => seen.includes("connected"), "connected");

		let pending = wire.ask("session:ping");
		wire.dispose();

		await expect(pending).rejects.toThrow();
	});
});

/**
 * Frames are fanned out in a loop, and a loop with no isolation means the first
 * handler to throw silences every handler after it — for the rest of the
 * session, in silence. The same shape as Lexical's update listeners, and just
 * as hard to notice: a broken sidecar would stop the transcript arriving.
 */
describe("fanning a frame out", () => {
	/** Sends every frame straight back, so a real one reaches the listeners. */
	function echo(): number {
		let server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, self) {
				return self.upgrade(req) ? undefined : new Response("no", { status: 400 });
			},
			websocket: {
				message(ws, raw) {
					ws.send(String(raw));
				},
			},
		});
		servers.push(server);
		return server.port!;
	}

	it("keeps delivering after one listener throws", async () => {
		let seen: Status[] = [];
		let wire = connect(echo(), seen);
		await until(() => seen.includes("connected"), "connected");

		let reached: string[] = [];
		wire.on("session:ping", () => {
			throw new Error("this listener is broken");
		});
		wire.on("session:ping", () => reached.push("second"));

		let complain = console.error;
		console.error = () => {};
		try {
			wire.send("session:ping");
			await until(() => reached.length > 0, "the listener behind the broken one");
		} finally {
			console.error = complain;
		}

		expect(reached).toEqual(["second"]);
	});
});
