import { expect, test } from "bun:test";

import { OpenSockets } from "../socket/open-sockets";
import { cut } from "./cut";
import { Requests } from "./requests";

import type { Server, ServerWebSocket } from "bun";

type Wire = { opened: Promise<void>; closed: Promise<{ bytes: string; at: number }> };

/** A bare TCP client: what it receives is exactly the bytes the server wrote to the connection. */
async function connect(port: number): Promise<Wire & { send(request: string): void }> {
	let chunks: Buffer[] = [];
	let opened = Promise.withResolvers<void>();
	let closed = Promise.withResolvers<{ bytes: string; at: number }>();
	let done = () =>
		closed.resolve({ bytes: Buffer.concat(chunks).toString(), at: performance.now() });
	let socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open: () => opened.resolve(),
			data: (_socket, data) => void chunks.push(Buffer.from(data)),
			close: done,
			end: done,
			error: done,
		},
	});
	return {
		opened: opened.promise,
		closed: closed.promise,
		send: request => void socket.write(request),
	};
}

const POST = (path: string) =>
	`POST ${path} HTTP/1.1\r\nHost: chopin.test\r\nContent-Length: 0\r\n\r\n`;

test("a request still running at the bound loses its connection without an answer, nothing is answered after the release, and sockets close last with 1012", async () => {
	let requests = new Requests({ holdMs: 100, exempt: () => false });
	let sockets = new OpenSockets();
	let work = Promise.withResolvers<void>();
	let events: string[] = [];
	let times: Record<string, number> = {};
	let note = (event: string) => {
		events.push(event);
		times[event] = performance.now();
	};
	let signalled = false;
	let server: Server<unknown> = Bun.serve<unknown>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, self) {
			let path = new URL(request.url).pathname;
			if (path === "/ws") {
				return self.upgrade(request, { data: {} })
					? undefined
					: new Response("no", { status: 400 });
			}
			return requests.handle(request, async abandoned => {
				if (path === "/quick") return new Response("quick");
				abandoned.addEventListener("abort", () => (signalled = true));
				await work.promise;
				note("handler finished");
				return new Response("after release");
			});
		},
		websocket: {
			open: (ws: ServerWebSocket<unknown>) => sockets.opened(ws),
			message() {},
			close: ws => sockets.closed(ws),
		},
	});
	try {
		let port = server.port!;
		let socketClosed = Promise.withResolvers<number>();
		let browser = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		browser.addEventListener("close", event => {
			note("socket closed");
			socketClosed.resolve(event.code);
		});
		await new Promise<void>(resolve => browser.addEventListener("open", () => resolve()));

		let slow = await connect(port);
		await slow.opened;
		slow.send(POST("/slow"));
		let idle = await connect(port);
		await idle.opened;
		slow.closed.then(() => note("slow connection closed"));
		while (requests.running === 0) await Bun.sleep(1);

		let quick = await fetch(`http://127.0.0.1:${port}/quick`, { method: "POST" });
		expect(await quick.text()).toBe("quick");

		let report = await cut(
			{
				unready() {},
				refused: () => 1,
				stopListening: async () => void server.stop(false),
				finishRequests: bound => requests.finish(bound),
				commit: async () => {
					// What the cut spends on documents, long enough to see who has been closed by now.
					await Bun.sleep(60);
				},
				persistLinkState: async () => {},
				release: async () => {
					note("released");
					// The handler gets its answer ready only now, as a handler that outlived the bound would.
					work.resolve();
					await Bun.sleep(60);
				},
				closeClients: async () => {
					await sockets.stopForRestart(server);
				},
			},
			{ unreadyMs: 0, requestWaitMs: 30 },
			{ info() {}, warn() {} },
		);

		expect(report.abandoned).toEqual(["POST /slow"]);
		let slowEnd = await slow.closed;
		expect(slowEnd.bytes).toBe("");
		expect(times["slow connection closed"]).toBeLessThan(times.released!);
		expect(signalled).toBe(true);

		// A request that reaches a connection that is still open afterwards is not answered either.
		idle.send(POST("/late"));
		expect((await idle.closed).bytes).toBe("");

		expect(await socketClosed.promise).toBe(1012);
		expect(times["socket closed"]).toBeGreaterThan(times.released!);
		expect(events.indexOf("released")).toBeLessThan(events.indexOf("socket closed"));
	} finally {
		await server.stop(true);
	}
});
