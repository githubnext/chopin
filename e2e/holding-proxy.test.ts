import { afterEach, describe, expect, it } from "bun:test";

import { closing, rewriteHead, startHoldingProxy } from "./holding-proxy";

import type { HoldingProxy } from "./holding-proxy";

/**
 * A port nothing can be served from, held for the test so that nothing else takes it while the
 * proxy looks there: it listens and hangs up on every connection. Every port comes from the system
 * (port 0); none is guessed from another's.
 */
function deadPort(): number {
	let listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.end();
			},
			data() {},
		},
	});
	cleanup.push(() => listener.stop(true));
	return listener.port;
}

type Upstream = { port: number; stop(): void };

/** A stand-in for one slot: ready answers 200 and everything else its own name. */
async function upstream(name: string): Promise<Upstream> {
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			let path = new URL(request.url).pathname;
			if (path === "/api/health/ready") return new Response("ready");
			if (path === "/socket" && server.upgrade(request)) return;
			return new Response(`${name} ${request.method}`);
		},
		websocket: {
			message(socket, message) {
				socket.send(`${name} ${message}`);
			},
		},
	});
	return { port: server.port!, stop: () => void server.stop(true) };
}

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (let step of cleanup.splice(0).toReversed()) await step();
});

async function proxy(upstreams: { a: number; b: number }): Promise<[number, HoldingProxy]> {
	let running = await startHoldingProxy(0, upstreams, {
		healthMs: 40,
		retryMs: 20,
		tryMs: 1_500,
		healthTimeoutMs: 200,
	});
	cleanup.push(() => running.stop());
	return [running.port, running];
}

describe("the holding proxy a browser test overlaps two servers behind", () => {
	it("gives each plain request the first ready upstream, one request to a connection", () => {
		expect(rewriteHead("GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nKeep-Alive: 5").text)
			.toBe("GET / HTTP/1.1\r\nHost: x\r\nConnection: close");
		expect(rewriteHead("GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket"))
			.toEqual({
				text: "GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket",
				upgrade: true,
			});
		expect(closing("HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2").text)
			.toBe("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close");
		expect(closing("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket").text)
			.toBe("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket");
	});

	it("holds a request while no upstream is ready and serves it from the one that becomes ready, with its body", async () => {
		let upstreams = { a: deadPort(), b: deadPort() };
		let [port, running] = await proxy(upstreams);
		let pending = fetch(`http://127.0.0.1:${port}/page`, { method: "POST", body: "payload" });
		await Bun.sleep(250);
		expect(running.served.at(-1)?.status).toBeUndefined();
		// The second slot starts, wherever the system puts it, and the proxy is told where to look.
		let late = await upstream("b");
		cleanup.push(() => late.stop());
		upstreams.b = late.port;
		let answer = await pending;
		expect(answer.status).toBe(200);
		expect(await answer.text()).toBe("b POST");
		expect(running.served.at(-1)).toMatchObject({ path: "/page", slot: "b", status: 200 });
		expect(running.served.at(-1)!.connectedAt - running.served.at(-1)!.startedAt)
			.toBeGreaterThan(200);
	});

	it("tries a refused connection again on the next upstream, for every method, instead of passing the refusal on", async () => {
		let a = await upstream("a");
		let b = await upstream("b");
		cleanup.push(() => b.stop());
		let [port, running] = await proxy({ a: a.port, b: b.port });
		for (let method of ["GET", "POST", "PUT", "DELETE"]) {
			expect(await (await fetch(`http://127.0.0.1:${port}/x`, { method })).text()).toBe(
				`a ${method}`,
			);
		}
		// The first slot stops listening before a readiness check has noticed.
		a.stop();
		let answers = await Promise.all(
			["GET", "POST", "DELETE"].map(method => fetch(`http://127.0.0.1:${port}/x`, { method })),
		);
		expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
		expect(await Promise.all(answers.map(answer => answer.text()))).toEqual([
			"b GET",
			"b POST",
			"b DELETE",
		]);
		expect(running.served.filter(request => request.status !== 200)).toEqual([]);
		expect(running.ready()).toEqual({ a: false, b: true });
	});

	it("answers 503 with Retry-After when no upstream is ready in the time it holds for", async () => {
		let [port, running] = await proxy({ a: deadPort(), b: deadPort() });
		let started = performance.now();
		let answer = await fetch(`http://127.0.0.1:${port}/x`);
		expect(answer.status).toBe(503);
		expect(answer.headers.get("retry-after")).toBe("1");
		expect(performance.now() - started).toBeGreaterThan(1_400);
		expect(running.served.at(-1)?.status).toBe(503);
	});

	it("carries a WebSocket through, in both directions, until one side closes it", async () => {
		let a = await upstream("a");
		cleanup.push(() => a.stop());
		let [port, running] = await proxy({ a: a.port, b: deadPort() });
		let socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
		let received = Promise.withResolvers<string>();
		socket.addEventListener("message", event => received.resolve(String(event.data)));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("no socket")));
		});
		socket.send("hello");
		expect(await received.promise).toBe("a hello");
		expect(running.served.at(-1)).toMatchObject({ upgrade: true, slot: "a", status: 101 });
		let closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve()));
		socket.close();
		await closed;
	});
});
