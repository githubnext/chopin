/**
 * What the connection says about itself.
 *
 * The failure this guards against was visible but silent: the header reported
 * a connection that had been thrown away, while a live socket sat behind it.
 * Status is the only account a user gets of why the editor will not accept
 * typing, so it being wrong is worse than it being absent.
 */

import { REFUSAL_HEADER, RESTART_QUIET_MS } from "@chopin/protocol/restart";
import { afterEach, describe, expect, it } from "bun:test";

import { Wire, WireLost } from "./wire";

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
			if (!accept) return new Response("nope", { status: 403, headers: { [REFUSAL_HEADER]: "1" } });
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

/** What a proxy with no upstream answers: a 4xx that Chopin did not send. */
function proxied(status: number): number {
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("no such upstream", { status }),
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

function restartable(): {
	port: number;
	deny: () => void;
	drop: () => void;
	restart: () => void;
	announce: (reconnectWithinMs: number) => void;
	probes: () => number;
	urls: () => string[];
} {
	let denied = false;
	let probes = 0;
	let urls: string[] = [];
	let sockets = new Set<ServerWebSocket<undefined>>();
	let server = Bun.serve<undefined>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, self) {
			if (req.headers.get("x-chopin-socket-probe") === "1") {
				probes++;
				return new Response(null, { status: denied ? 401 : 204 });
			}
			if (denied) return new Response("authentication required", { status: 401 });
			urls.push(req.url);
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
		restart: () => {
			for (let socket of sockets) socket.close(1012, "server restarting");
		},
		announce: reconnectWithinMs => {
			let frame = JSON.stringify({ kind: "session:restarting", ts: 1, reconnectWithinMs });
			for (let socket of sockets) socket.send(frame);
		},
		probes: () => probes,
		urls: () => urls,
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

async function until(check: () => boolean, label: string, ms = 2_000): Promise<void> {
	for (let i = 0; i < ms / 10; i++) {
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

	it("retries a 4xx that did not come from Chopin, where it used to stop for good", async () => {
		for (let status of [403, 404, 429]) {
			let seen: Status[] = [];
			let wire = connect(proxied(status), seen);
			await until(() => wire.status === "reconnecting", `reconnecting after ${status}`);
			await Bun.sleep(300);
			expect(seen).not.toContain("denied");
			// Between attempts it reads reconnecting and during one connecting, so which it is
			// depends on where the retry's wait has got to; what matters is that it is still trying.
			expect(["connecting", "reconnecting"]).toContain(wire.status);
			wire.dispose();
		}
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

	describe("a server that says it is restarting", () => {
		it("is reconnected to within a second, without asking first whether the door is open", async () => {
			let service = restartable();
			let seen: Status[] = [];
			let wire = connect(service.port, seen);
			await until(() => wire.status === "connected", "connected");
			expect(wire.restarting).toBe(false);

			let random = Math.random;
			Math.random = () => 0.5;
			try {
				let lost = Date.now();
				service.restart();
				await until(() => wire.restarting, "marked as a restart");
				expect(wire.connected).toBe(false);
				expect(wire.status).toBe("reconnecting");
				await until(() => seen.filter(status => status === "connected").length === 2, "back");
				let waited = Date.now() - lost;
				expect(waited).toBeGreaterThanOrEqual(450);
				expect(waited).toBeLessThan(1500);
			} finally {
				Math.random = random;
			}
			expect(wire.restarting).toBe(false);
			expect(service.probes()).toBe(0);
		});

		it("spreads its first attempt over a second, so tabs do not return together", async () => {
			let service = restartable();
			let seen: Status[] = [];
			let wire = connect(service.port, seen);
			await until(() => wire.status === "connected", "connected");

			let random = Math.random;
			Math.random = () => 0.999;
			try {
				let lost = Date.now();
				service.restart();
				await until(() => seen.filter(status => status === "connected").length === 2, "back");
				expect(Date.now() - lost).toBeGreaterThanOrEqual(950);
			} finally {
				Math.random = random;
			}
		});

		it(
			"keeps knocking about once a second while the restart is quiet, so a server that is back is found at once",
			async () => {
				let attempts: number[] = [];
				let refusing = false;
				let sockets = new Set<ServerWebSocket<undefined>>();
				let server = Bun.serve<undefined>({
					port: 0,
					hostname: "127.0.0.1",
					fetch(request, self) {
						if (request.headers.get("x-chopin-socket-probe") === "1") {
							return new Response("try again", { status: 503 });
						}
						attempts.push(Date.now());
						if (refusing) return new Response("try again", { status: 503 });
						return self.upgrade(request) ? undefined : new Response("no", { status: 400 });
					},
					websocket: {
						open: socket => {
							sockets.add(socket);
						},
						message() {},
					},
				});
				servers.push(server);
				let seen: Status[] = [];
				let wire = connect(server.port!, seen);
				await until(() => wire.status === "connected", "connected");
				attempts.length = 0;

				// The widest jitter, so that only the quiet knocking, not the ladder, can pass for it.
				let random = Math.random;
				Math.random = () => 0.999;
				try {
					refusing = true;
					let lost = Date.now();
					for (let socket of sockets) socket.close(1012, "server restarting");
					await until(() => attempts.length >= 4, "four attempts in the quiet", 5_000);
					expect(Date.now() - lost).toBeLessThan(4_500);
					expect(wire.restarting).toBe(true);
					expect(seen).not.toContain("denied");
					// The ladder alone, from its second step, would be 1.5 s and then 3 s apart.
					for (let index = 1; index < attempts.length; index++) {
						expect(attempts[index]! - attempts[index - 1]!).toBeLessThan(1_300);
					}

					refusing = false;
					let back = Date.now();
					await until(
						() => seen.filter(status => status === "connected").length === 2,
						"back",
						3_000,
					);
					expect(Date.now() - back).toBeLessThan(1_500);
					expect(wire.restarting).toBe(false);
				} finally {
					Math.random = random;
				}
			},
			15_000,
		);

		it("goes on the ordinary backoff, from where it was, once the quiet has passed", async () => {
			// The ladder's steps are timed on the real clock, but the quiet period is read from
			// `Date.now`, which is moved past it inside the third probe's answer, before the wire
			// reads it. So where a knock happens to land against the five seconds never matters.
			let attempts: number[] = [];
			let sockets = new Set<ServerWebSocket<undefined>>();
			let refusing = false;
			let probes = 0;
			let skew = 0;
			let clock = Date.now;
			let server = Bun.serve<undefined>({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request, self) {
					if (request.headers.get("x-chopin-socket-probe") === "1") {
						if (refusing && ++probes === 3) skew = RESTART_QUIET_MS + 1_000;
						return new Response("try again", { status: 503 });
					}
					if (refusing) {
						attempts.push(performance.now());
						return new Response("try again", { status: 503 });
					}
					return self.upgrade(request) ? undefined : new Response("no", { status: 400 });
				},
				websocket: {
					open: socket => {
						sockets.add(socket);
					},
					message() {},
				},
			});
			servers.push(server);
			let wire = connect(server.port!, []);
			await until(() => wire.status === "connected", "connected");

			let random = Math.random;
			Math.random = () => 0.999;
			Date.now = () => clock() + skew;
			try {
				refusing = true;
				for (let socket of sockets) socket.close(1012, "server restarting");
				await until(() => attempts.length >= 5, "five attempts", 15_000);
				// The first attempt and two knocks fall in the quiet. Then the ladder goes on from its
				// second step: 1.5 s, and 3 s after that. Counting the knocks towards it would make the
				// first wait 6 s, and starting it from the beginning would make it 0.75 s.
				let gaps = [attempts[3]! - attempts[2]!, attempts[4]! - attempts[3]!];
				expect(gaps[0]).toBeGreaterThan(1_300);
				expect(gaps[0]).toBeLessThan(3_000);
				expect(gaps[1]).toBeGreaterThan(2_700);
				expect(gaps[1]).toBeLessThan(5_000);
			} finally {
				Date.now = clock;
				Math.random = random;
			}
		}, 20_000);

		it("tells a request that was in flight that a restart cut it off, so it can be made again quietly", async () => {
			let service = restartable();
			let wire = connect(service.port, []);
			await until(() => wire.status === "connected", "connected");

			let outcome = wire.ask("chat:send", { text: "hello" }).then(() => undefined, error => error);
			service.restart();
			let error = await outcome;
			expect(error).toBeInstanceOf(WireLost);
			expect((error as WireLost).restarting).toBe(true);
			expect(wire.restarting).toBe(true);
		});

		it("does not call a request lost to a plain drop a restart", async () => {
			let service = restartable();
			let wire = connect(service.port, []);
			await until(() => wire.status === "connected", "connected");

			let outcome = wire.ask("chat:send", { text: "hello" }).then(() => undefined, error => error);
			service.drop();
			let error = await outcome;
			expect(error).toBeInstanceOf(WireLost);
			expect((error as WireLost).restarting).toBe(false);
			expect((error as WireLost).message).toBe("connection lost");
		});

		it("reads a drop that follows session:restarting as a restart, whatever its close code", async () => {
			let service = restartable();
			let wire = connect(service.port, []);
			await until(() => wire.status === "connected", "connected");

			// The first attempt waits a drawn jitter of up to a second, and a failed one up to a second
			// more: together as long as this test waits for the connection to be back, so on a loaded
			// machine it timed out. Drawn as 0.3, the jitter is 300 ms, long enough to see the restart
			// and short enough to leave the wait to the machine.
			let random = Math.random;
			Math.random = () => 0.3;
			try {
				service.announce(30_000);
				service.drop();
				await until(() => wire.restarting, "marked as a restart");
				await until(() => wire.status === "connected", "back");
			} finally {
				Math.random = random;
			}
			expect(wire.restarting).toBe(false);

			// The announcement belongs to the socket that heard it: a later plain drop is not a restart.
			service.drop();
			await until(() => wire.status === "reconnecting", "reconnecting");
			expect(wire.restarting).toBe(false);
		});

		it("is not a restart when the connection is merely dropped", async () => {
			let service = restartable();
			let seen: Status[] = [];
			let wire = connect(service.port, seen);
			await until(() => wire.status === "connected", "connected");
			service.drop();
			await until(() => wire.status === "reconnecting", "reconnecting");
			expect(wire.restarting).toBe(false);
			await until(() => wire.status === "connected", "back");
		});
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

	describe("outage", () => {
		/** A server that can be taken down and brought back, and counts the sockets it refused. */
		function flaky(): { port: number; down: () => void; up: () => void; drop: () => void } {
			let refusing = false;
			let sockets = new Set<ServerWebSocket<undefined>>();
			let server = Bun.serve<undefined>({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request, self) {
					if (request.headers.get("x-chopin-socket-probe") === "1") {
						return new Response(null, { status: 204 });
					}
					if (refusing) return new Response("try again", { status: 503 });
					return self.upgrade(request) ? undefined : new Response("no", { status: 400 });
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
				down: () => {
					refusing = true;
				},
				up: () => {
					refusing = false;
				},
				drop: () => {
					for (let socket of sockets) socket.terminate();
				},
			};
		}

		function watched(
			port: number,
		): { wire: Wire; outages: Array<{ failures: number } | undefined> } {
			globalThis.location = { href: `http://127.0.0.1:${port}/`, protocol: "http:" } as Location;
			let outages: Array<{ failures: number } | undefined> = [];
			let wire = new Wire({
				channelId: "019c1234-1234-4123-8123-123456789abc",
				onOutage: outage => outages.push(outage),
			});
			wires.push(wire);
			return { wire, outages };
		}

		it("says nothing while connected, begins when the connection is lost, and ends when it opens again", async () => {
			let service = flaky();
			let { wire, outages } = watched(service.port);
			await until(() => wire.status === "connected", "connected");
			expect(outages).toEqual([]);

			service.drop();
			await until(() => outages.length > 0, "outage");
			expect(outages[0]).toEqual({ failures: 0 });

			await until(() => wire.status === "connected" && outages.at(-1) === undefined, "recovered");
		});

		it("counts each automatic attempt that fails, and a refused one that a person starts", async () => {
			let random = Math.random;
			Math.random = () => 0;
			try {
				let service = flaky();
				let { wire, outages } = watched(service.port);
				await until(() => wire.status === "connected", "connected");

				service.down();
				service.drop();
				await until(() => outages.at(-1)?.failures === 2, "two failed attempts");
				expect(outages.slice(0, 3)).toEqual([
					{ failures: 0 },
					{ failures: 1 },
					{ failures: 2 },
				]);

				// Asking to reconnect starts the backoff over, not the count: the attempt that
				// fails is one more failure in the same outage.
				let before = outages.at(-1)!.failures;
				wire.reconnect();
				await until(() => outages.at(-1)!.failures > before, "a failed manual attempt");

				service.up();
				await until(() => outages.at(-1) === undefined, "recovered");
			} finally {
				Math.random = random;
			}
		});

		it("does not forget the count when the network comes back and the server is still down", async () => {
			let random = Math.random;
			Math.random = () => 0;
			try {
				let service = flaky();
				let { wire, outages } = watched(service.port);
				await until(() => wire.status === "connected", "connected");
				service.down();
				service.drop();
				await until(() => outages.at(-1)?.failures === 2, "two failed attempts");

				dispatchEvent(new Event("online"));
				await until(() => outages.at(-1)!.failures >= 3, "an attempt woken by the network");
				expect(outages.every(outage => outage !== undefined)).toBe(true);
			} finally {
				Math.random = random;
			}
		});

		/**
		 * A server whose probe, the request that asks why a connection was lost, can be made to
		 * hang for good, as a network that drops packets does, while its sockets still open.
		 */
		function mute(): {
			port: number;
			hang: (on: boolean) => void;
			drop: () => void;
			probes: () => number;
		} {
			let hanging = false;
			let probes = 0;
			let sockets = new Set<ServerWebSocket<undefined>>();
			let server = Bun.serve<undefined>({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request, self) {
					if (request.headers.get("x-chopin-socket-probe") === "1") {
						probes++;
						return hanging ? new Promise<Response>(() => {}) : new Response(null, { status: 204 });
					}
					return self.upgrade(request) ? undefined : new Response("no", { status: 400 });
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
				hang: on => {
					hanging = on;
				},
				drop: () => {
					for (let socket of sockets) socket.terminate();
				},
				probes: () => probes,
			};
		}

		it("is an outage the moment a connection is lost, even while the probe that asks why never answers", async () => {
			let service = mute();
			let { wire, outages } = watched(service.port);
			await until(() => wire.status === "connected", "connected");

			service.hang(true);
			service.drop();
			await until(() => service.probes() > 0, "the probe");
			// The probe is still out, and the page is already told: the outage, and a status that is
			// no longer `connected`, so a notice need not wait on the probe.
			expect(outages.at(-1)).toEqual({ failures: 0 });
			expect(wire.status).toBe("reconnecting");
			expect(wire.connected).toBe(false);
		});

		it("is not stalled by a probe that never answers: it gives up on it and keeps trying", async () => {
			let timeout = AbortSignal.timeout;
			let random = Math.random;
			AbortSignal.timeout = () => timeout.call(AbortSignal, 120);
			Math.random = () => 0;
			try {
				let service = mute();
				let { wire, outages } = watched(service.port);
				await until(() => wire.status === "connected", "connected");

				service.hang(true);
				service.drop();
				await until(() => service.probes() > 0, "the first probe");
				// Later probes answer; only the first hangs, and without a bound nothing would
				// ever follow it.
				service.hang(false);
				await until(
					() => wire.status === "connected" && outages.at(-1) === undefined,
					"reconnected past the hung probe",
				);
			} finally {
				AbortSignal.timeout = timeout;
				Math.random = random;
			}
		});

		it("is woken by the network coming back while a probe is still out", async () => {
			let service = mute();
			let { wire } = watched(service.port);
			await until(() => wire.status === "connected", "connected");

			service.hang(true);
			service.drop();
			await until(() => service.probes() > 0, "the probe");
			service.hang(false);
			let woken = Date.now();
			dispatchEvent(new Event("online"));
			await until(() => wire.status === "connected", "woken reconnect");
			// Well before the probe's own bound would have let the retry begin.
			expect(Date.now() - woken).toBeLessThan(1000);
		});

		it("is not an outage when the first connection is merely slow", async () => {
			let service = flaky();
			let { wire, outages } = watched(service.port);
			await until(() => wire.status === "connected", "connected");
			expect(outages).toEqual([]);
		});

		it("is not an outage once a document is deleted", async () => {
			let service = deleted("close");
			globalThis.location = {
				href: `http://127.0.0.1:${service.port}/`,
				protocol: "http:",
			} as Location;
			let outages: Array<{ failures: number } | undefined> = [];
			let wire = new Wire({
				channelId: "019c1234-1234-4123-8123-123456789abc",
				onOutage: outage => outages.push(outage),
			});
			wires.push(wire);
			await until(() => wire.status === "deleted", "deleted");
			expect(outages).toEqual([]);
		});
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
describe("the build a socket names", () => {
	it("is sent as a query parameter when the page has an entry script, and left out when it has none", async () => {
		let page = globalThis.document;
		try {
			let service = restartable();
			let wire = connect(service.port, []);
			await until(() => wire.status === "connected", "connected");
			expect(new URL(service.urls().at(-1)!).searchParams.has("build")).toBe(false);
			wire.dispose();

			globalThis.document = {
				querySelector: () => ({ getAttribute: () => "/assets/index-AbCd1234.js" }),
				addEventListener() {},
				removeEventListener() {},
			} as unknown as Document;
			let again = connect(service.port, []);
			await until(() => service.urls().length === 2, "second attempt");
			expect(new URL(service.urls().at(-1)!).searchParams.get("build")).toBe(
				"/assets/index-AbCd1234.js",
			);
			again.dispose();
		} finally {
			globalThis.document = page;
		}
	});
});

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
