import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { matchingEntries, ownerEntry } from "./sandbox-policy";

/** The proxy a sandbox's only way out goes through. */
export type Proxy = {
	/** The loopback URL MXC points the sandbox at. */
	url: string;
	port: number;
	close(): Promise<void>;
};

export type ProxyOptions = {
	/** The hosts a run may reach; see `allowedHosts`. */
	hosts: readonly string[];
	/** Hears each connection it refuses, once per host and port, with why. */
	refused?: (host: string, port: number, why: string) => void;
	/** Resolves a name; for tests. */
	resolve?: (host: string) => Promise<string[]>;
};

const HEAD_LIMIT = 16 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");

/**
 * Whether an address is one a built-in name must not lead to: this machine, its networks,
 * link-local and cloud metadata addresses. A public service may not be pointed at a service on the
 * machine it runs on.
 */
export function privateAddress(address: string): boolean {
	let mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) address = mapped[1]!;
	if (isIP(address) === 4) {
		let [a, b] = address.split(".").map(Number) as [number, number];
		return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
			|| a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
			|| a === 100 && b >= 64 && b <= 127
			|| a === 192 && b === 0;
	}
	let lower = address.toLowerCase();
	return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
		|| lower.startsWith("ff");
}

async function resolveAll(host: string) {
	return (await lookup(host, { all: true })).map(entry => entry.address);
}

/**
 * Start the allow-list proxy on loopback: HTTP CONNECT tunnels and plain HTTP requests (a
 * WebSocket upgrade among them) to the hosts in `hosts`, and a 403 for anything else. It sees
 * names and ports only, never what a tunnel carries. A built-in name is refused when it leads to a
 * private address; Chopin's own origin and the hosts the owner added are not, as they may be on a
 * private network (see `ownerEntry`).
 */
export async function startProxy(options: ProxyOptions): Promise<Proxy> {
	let resolve = options.resolve ?? resolveAll;
	let told = new Set<string>();
	let sockets = new Set<Socket>();
	let refuse = (client: Socket, host: string, port: number, why: string) => {
		let key = `${host}:${port}`;
		if (!told.has(key)) {
			told.add(key);
			options.refused?.(host, port, why);
		}
		let body = `chopin sandbox: ${host}:${port} is not on the allow list (${why})\n`;
		client.end(
			`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${
				Buffer.byteLength(body)
			}\r\nconnection: close\r\n\r\n${body}`,
		);
	};
	let open = async (client: Socket, host: string, port: number) => {
		let entries = matchingEntries(options.hosts, host, port);
		if (!entries.length) {
			refuse(client, host, port, "not listed");
			return undefined;
		}
		let addresses: string[];
		try {
			addresses = isIP(host.replace(/^\[|\]$/g, ""))
				? [host.replace(/^\[|\]$/g, "")]
				: await resolve(host);
		} catch {
			client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
			return undefined;
		}
		let safe = entries.some(ownerEntry)
			? addresses
			: addresses.filter(address => !privateAddress(address));
		if (!safe[0]) {
			refuse(client, host, port, "resolves to a private address");
			return undefined;
		}
		return await new Promise<Socket | undefined>(done => {
			let upstream = connect({ host: safe[0]!, port });
			upstream.once("connect", () => done(upstream));
			upstream.once("error", () => {
				client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
				done(undefined);
			});
		});
	};
	let serve = (client: Socket) => {
		sockets.add(client);
		client.once("close", () => sockets.delete(client));
		client.on("error", () => client.destroy());
		let buffered = Buffer.alloc(0);
		let onData = async (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			let end = buffered.indexOf(HEAD_END);
			if (end < 0) {
				if (buffered.length > HEAD_LIMIT) client.destroy();
				return;
			}
			client.off("data", onData);
			client.pause();
			let head = buffered.subarray(0, end).toString("latin1");
			let rest = buffered.subarray(end + HEAD_END.length);
			let [line = "", ...headers] = head.split("\r\n");
			let [method = "", target = ""] = line.split(" ");
			let host: string;
			let port: number;
			let forward: Buffer | undefined;
			if (method === "CONNECT") {
				let match = target.match(/^(\[[0-9a-f:]+\]|[^:]+):(\d{1,5})$/i);
				if (!match) return void client.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
				host = match[1]!;
				port = Number(match[2]);
			} else {
				let url: URL;
				try {
					url = new URL(target);
				} catch {
					return void client.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
				}
				// A WebSocket's ws:// URL is the same request as an http:// one; wss:// needs CONNECT.
				if (url.protocol !== "http:" && url.protocol !== "ws:") {
					return void client.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
				}
				host = url.hostname;
				port = Number(url.port || 80);
				let kept = headers.filter(header =>
					!/^(proxy-connection|connection|proxy-authorization):/i.test(header)
				);
				// A request for an upgrade keeps the two headers it is made of; the connection it opens
				// carries the upgraded protocol both ways. Any other request is one and done, so the
				// next is checked against the list too.
				let upgrading = kept.some(header => /^upgrade:\s*\S/i.test(header))
					&& headers.some(header => /^connection:.*\bupgrade\b/i.test(header));
				forward = Buffer.concat([
					Buffer.from(
						`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${
							kept.join("\r\n")
						}\r\nconnection: ${upgrading ? "Upgrade" : "close"}\r\n\r\n`,
						"latin1",
					),
					rest,
				]);
			}
			let upstream = await open(client, host, port);
			if (!upstream) return;
			sockets.add(upstream);
			upstream.once("close", () => sockets.delete(upstream));
			upstream.on("error", () => client.destroy());
			client.once("close", () => upstream.destroy());
			upstream.once("close", () => client.destroy());
			if (forward) upstream.write(forward);
			else {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (rest.length) upstream.write(rest);
			}
			client.pipe(upstream);
			upstream.pipe(client);
			client.resume();
		};
		client.on("data", onData);
	};
	let server: Server = createServer(serve);
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => done());
	});
	let port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		close: () =>
			new Promise<void>(done => {
				for (let socket of sockets) socket.destroy();
				server.close(() => done());
			}),
	};
}
