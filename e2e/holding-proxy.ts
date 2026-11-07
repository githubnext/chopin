/**
 * A proxy that does what a deploy needs of one, small enough to run inside a test: it sends each
 * request to the first upstream whose readiness check passes, holds a request while none does,
 * and tries a refused connection again, as `deploy/overlap/Caddyfile` (docs/zero-downtime-deploys.md)
 * asks of Caddy: active health checks of `/api/health/ready` every 250 ms, a request held for up
 * to 5 s, a retry every 100 ms, and a WebSocket kept until one side closes it. It speaks to the
 * connections only as far as the first request line and header block: each plain request gets
 * `Connection: close`, so a connection carries one request, which is what lets it be held and
 * sent to whichever upstream is ready when its turn comes.
 *
 * Browser tests that overlap two servers use it where the reference Caddy cannot be assumed
 * (`CHOPIN_E2E_PROXY=caddy` runs that one instead; see `e2e/handover.e2e.ts`).
 */
import { connect, createServer } from "node:net";

import type { AddressInfo, Server, Socket } from "node:net";

export type Slot = "a" | "b";

export type ProxyOptions = {
	/** How often each upstream's readiness is checked. */
	healthMs?: number;
	/** How long a request is held while no upstream is ready. */
	tryMs?: number;
	/** How long to wait before choosing an upstream again after a refused connection. */
	retryMs?: number;
	healthTimeoutMs?: number;
};

/** What the proxy did with one request, on the clock of `performance.now()`. */
export type Served = {
	method: string;
	path: string;
	upgrade: boolean;
	/** The upstream's status line, or undefined if it sent none (a connection cut, or none ready). */
	status?: number;
	/** The upstream it went to. */
	slot?: Slot;
	startedAt: number;
	/** When it was connected to an upstream, or gave up. */
	connectedAt: number;
};

export type HoldingProxy = {
	/** The port it listens on: the one asked for, or the one the system chose for port 0. */
	port: number;
	/** Every request taken so far, in order. */
	served: Served[];
	/** The upstreams the last readiness checks found ready. */
	ready(): Record<Slot, boolean>;
	stop(): Promise<void>;
};

const HEAD_LIMIT = 64 * 1024;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The request line and headers with `Connection: close`, unless the request is an upgrade. */
export function rewriteHead(head: string): { text: string; upgrade: boolean } {
	let [line, ...headers] = head.split("\r\n");
	let upgrade = headers.some(header => /^upgrade:/i.test(header));
	if (upgrade) return { text: head, upgrade };
	let kept = headers.filter(header => !/^(connection|proxy-connection|keep-alive):/i.test(header));
	return { text: [line, ...kept, "Connection: close"].join("\r\n"), upgrade };
}

/**
 * The status line and headers of an answer with `Connection: close`, so the client does not send
 * another request on a connection that is bound to one upstream; a switch to WebSocket is left as is.
 */
export function closing(head: string): { text: string } {
	let [line = "", ...headers] = head.split("\r\n");
	if (/^HTTP\/1\.[01] 101/.test(line)) return { text: head };
	let kept = headers.filter(header => !/^(connection|keep-alive):/i.test(header));
	return { text: [line, ...kept, "Connection: close"].join("\r\n") };
}

/**
 * Port 0 lets the system choose where it listens, and `port` says which. The upstreams are read
 * each time they are used, so one that is not there yet can be given its port when it starts.
 */
export async function startHoldingProxy(
	port: number,
	upstreams: Record<Slot, number>,
	options: ProxyOptions = {},
): Promise<HoldingProxy> {
	let { healthMs = 250, tryMs = 5_000, retryMs = 100, healthTimeoutMs = 1_000 } = options;
	let state: Record<Slot, boolean> = { a: false, b: false };
	let served: Served[] = [];
	let sockets = new Set<Socket>();
	let alive = { running: true };

	let check = async (slot: Slot) => {
		try {
			let response = await fetch(`http://127.0.0.1:${upstreams[slot]}/api/health/ready`, {
				headers: { connection: "close" },
				signal: AbortSignal.timeout(healthTimeoutMs),
			});
			await response.arrayBuffer();
			state[slot] = response.status === 200;
		} catch {
			state[slot] = false;
		}
	};
	await Promise.all((["a", "b"] as const).map(check));
	let checking = Promise.all((["a", "b"] as const).map(async slot => {
		while (alive.running) {
			await sleep(healthMs);
			if (alive.running) await check(slot);
		}
	}));

	/** The first upstream that is ready, held for up to `tryMs`, and a connection to it. */
	async function upstream(
		gone: () => boolean,
	): Promise<{ slot: Slot; socket: Socket } | undefined> {
		for (let deadline = performance.now() + tryMs; performance.now() < deadline && !gone();) {
			let slot = (["a", "b"] as const).find(candidate => state[candidate]);
			if (slot) {
				let socket = await new Promise<Socket | undefined>(resolve => {
					let attempt = connect({ host: "127.0.0.1", port: upstreams[slot!] });
					attempt.once("connect", () => resolve(attempt));
					attempt.once("error", () => resolve(undefined));
				});
				if (socket) return { slot, socket };
			}
			await sleep(retryMs);
		}
		return undefined;
	}

	let server: Server = createServer(client => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		client.on("error", () => {});
		let chunks: Buffer[] = [];
		let buffered = 0;
		let closed = false;
		client.on("close", () => closed = true);
		let onData = (chunk: Buffer) => {
			chunks.push(chunk);
			buffered += chunk.length;
			let all = Buffer.concat(chunks);
			let end = all.indexOf("\r\n\r\n");
			if (end < 0) {
				if (buffered > HEAD_LIMIT) client.destroy();
				return;
			}
			client.off("data", onData);
			chunks = [all];
			void route(all, end);
		};
		async function route(all: Buffer, end: number) {
			let head = all.subarray(0, end).toString("latin1");
			let [method = "", path = ""] = head.split(" ", 3);
			let { text, upgrade } = rewriteHead(head);
			// Whatever the client sends while its request is held waits here for the upstream.
			let pending: Buffer[] = [];
			let forward = (chunk: Buffer) => void pending.push(chunk);
			client.on("data", (chunk: Buffer) => forward(chunk));
			let record: Served = {
				method,
				path,
				upgrade,
				startedAt: performance.now(),
				connectedAt: 0,
			};
			served.push(record);
			let found = await upstream(() => closed);
			record.connectedAt = performance.now();
			if (!found) {
				if (!closed) {
					client.end(
						"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\n"
							+ "Connection: close\r\n\r\n",
					);
					record.status = 503;
				}
				return;
			}
			record.slot = found.slot;
			let target = found.socket;
			sockets.add(target);
			target.on("close", () => {
				sockets.delete(target);
				client.end();
			});
			target.on("error", () => client.destroy());
			client.on("close", () => target.destroy());
			let first: Buffer[] | undefined = [];
			target.on("data", (chunk: Buffer) => {
				if (!first) return void client.write(chunk);
				first.push(chunk);
				let all = Buffer.concat(first);
				let split = all.indexOf("\r\n\r\n");
				if (split < 0 && all.length < HEAD_LIMIT) return;
				first = undefined;
				let answer = split < 0 ? undefined : closing(all.subarray(0, split).toString("latin1"));
				record.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer?.text ?? "")?.[1]) || undefined;
				client.write(
					answer
						? Buffer.concat([
							Buffer.from(`${answer.text}\r\n\r\n`, "latin1"),
							all.subarray(split + 4),
						])
						: all,
				);
			});
			target.on("end", () => client.end());
			client.on("end", () => {
				// A plain request has been sent whole; an upgrade's half-close is its own.
				if (!upgrade) return;
				target.end();
			});
			target.write(Buffer.concat([
				Buffer.from(`${text}\r\n\r\n`, "latin1"),
				all.subarray(end + 4),
				...pending.splice(0),
			]));
			forward = (chunk: Buffer) => void target.write(chunk);
		}
		client.on("data", onData);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	return {
		port: (server.address() as AddressInfo).port,
		served,
		ready: () => ({ ...state }),
		async stop() {
			alive.running = false;
			for (let socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			await checking;
		},
	};
}
