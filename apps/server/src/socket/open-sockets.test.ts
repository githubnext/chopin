import { SERVICE_RESTART } from "@chopin/protocol/restart";
import { afterEach, expect, test } from "bun:test";

import { OpenSockets } from "./open-sockets";

import type { Server, ServerWebSocket } from "bun";

let clients: WebSocket[] = [];

afterEach(() => {
	for (let client of clients) client.close();
	clients = [];
});

function serve(sockets: OpenSockets) {
	let server = Bun.serve<undefined>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, self) {
			if (self.upgrade(request)) return undefined;
			return new Response("plain");
		},
		websocket: {
			open(ws: ServerWebSocket<undefined>) {
				sockets.opened(ws);
			},
			close(ws: ServerWebSocket<undefined>) {
				sockets.closed(ws);
			},
			message() {},
		},
	});
	return server;
}

async function connect(
	server: Server<undefined>,
): Promise<{ closed: Promise<CloseEvent>; frames: unknown[] }> {
	let client = new WebSocket(`ws://127.0.0.1:${server.port}/`);
	clients.push(client);
	let frames: unknown[] = [];
	client.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	let closed = new Promise<CloseEvent>(resolve => client.addEventListener("close", resolve));
	await new Promise(resolve => client.addEventListener("open", resolve, { once: true }));
	return { closed, frames };
}

test("every open socket is closed with 1012, where server.stop(true) alone says 1001", async () => {
	let plain = serve(new OpenSockets());
	let before = await connect(plain);
	await plain.stop(true);
	expect((await before.closed).code).toBe(1001);

	let sockets = new OpenSockets();
	let server = serve(sockets);
	let open = await Promise.all([connect(server), connect(server), connect(server)]);
	await sockets.stopForRestart(server);
	for (let socket of open) {
		let event = await socket.closed;
		expect([event.code, event.reason, event.wasClean]).toEqual([
			SERVICE_RESTART,
			"server restarting",
			true,
		]);
	}
});

test("a socket that closed on its own is forgotten, and the listener stops taking new ones", async () => {
	let sockets = new OpenSockets();
	let server = serve(sockets);
	let leaving = await connect(server);
	clients.at(-1)!.close(1000, "done");
	expect((await leaving.closed).code).toBe(1000);
	let staying = await connect(server);
	await sockets.stopForRestart(server);
	expect((await staying.closed).code).toBe(SERVICE_RESTART);
	await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow();
});

test("a restart is announced to every open socket, with when to come back, before it is closed", async () => {
	let sockets = new OpenSockets();
	let server = serve(sockets);
	let open = await Promise.all([connect(server), connect(server)]);
	sockets.announceRestart(10_000);
	await sockets.stopForRestart(server);
	for (let socket of open) {
		expect((await socket.closed).code).toBe(SERVICE_RESTART);
		expect(socket.frames).toHaveLength(1);
		expect(socket.frames[0]).toMatchObject({
			kind: "session:restarting",
			reconnectWithinMs: 10_000,
		});
	}
});

test("an agent link is told through its own protocol, and is sent no browser frame", async () => {
	let sockets = new OpenSockets();
	let restarts: number[] = [];
	let server = Bun.serve<{ agent: boolean }>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, self) {
			let agent = new URL(request.url).searchParams.has("agent");
			if (self.upgrade(request, { data: { agent } })) return undefined;
			return new Response("plain");
		},
		websocket: {
			open(ws) {
				sockets.opened(ws);
			},
			close(ws) {
				sockets.closed(ws);
			},
			message() {},
		},
	});
	let connectTo = async (query: string) => {
		let client = new WebSocket(`ws://127.0.0.1:${server.port}/${query}`);
		clients.push(client);
		let frames: unknown[] = [];
		client.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		let closed = new Promise<CloseEvent>(resolve => client.addEventListener("close", resolve));
		await new Promise(resolve => client.addEventListener("open", resolve, { once: true }));
		return { closed, frames };
	};
	let browser = await connectTo("");
	let agent = await connectTo("?agent");
	sockets.announceRestart(
		10_000,
		ws => (ws.data as { agent: boolean }).agent ? { restart: ms => restarts.push(ms) } : undefined,
	);
	await sockets.stopForRestart(server);
	expect((await agent.closed).code).toBe(SERVICE_RESTART);
	expect((await browser.closed).code).toBe(SERVICE_RESTART);
	expect(restarts).toEqual([10_000]);
	expect(agent.frames).toEqual([]);
	expect(browser.frames).toMatchObject([{ kind: "session:restarting", reconnectWithinMs: 10_000 }]);
});
