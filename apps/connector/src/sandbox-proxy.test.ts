import { afterAll, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { allowedHosts } from "./sandbox-policy";
import { privateAddress, type Proxy, startProxy } from "./sandbox-proxy";

let servers: Array<{ close(): unknown }> = [];
let proxies: Proxy[] = [];
afterAll(async () => {
	for (let server of servers) server.close();
	await Promise.all(proxies.map(proxy => proxy.close()));
});

/** A server on loopback that says who it is to each connection, and answers a plain request. */
function listener(name: string) {
	let server = createServer(socket => {
		socket.on("data", data => {
			let text = data.toString();
			socket.end(
				text.startsWith("GET ")
					? `HTTP/1.1 200 OK\r\ncontent-length: ${name.length}\r\n\r\n${name}`
					: `${name}:${text}`,
			);
		});
	}).listen(0, "127.0.0.1");
	servers.push(server);
	return (server.address() as { port: number }).port;
}

/** Ask the proxy `head`, then give it `after` once it has answered; resolves with everything it said. */
function ask(proxy: Proxy, head: string, after?: string): Promise<string> {
	return new Promise(done => {
		let socket = connect(proxy.port, "127.0.0.1");
		let said = "";
		socket.setEncoding("latin1");
		socket.on("connect", () => socket.write(head));
		socket.on("data", chunk => {
			said += chunk;
			if (after && said.includes("\r\n\r\n") && !said.includes("sent")) {
				socket.write(after);
				said += "sent";
			}
		});
		socket.on("close", () => done(said));
		setTimeout(() => socket.destroy(), 2000);
	});
}

test("a CONNECT to a listed host and port is tunnelled, and nothing else is", async () => {
	let port = listener("echo");
	let refused: string[] = [];
	let proxy = await startProxy({
		hosts: [`127.0.0.1:${port}`],
		refused: (host, number) => refused.push(`${host}:${number}`),
	});
	proxies.push(proxy);
	let tunnelled = await ask(
		proxy,
		`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\n\r\n`,
		"hello",
	);
	expect(tunnelled).toContain("HTTP/1.1 200 Connection Established");
	expect(tunnelled).toContain("echo:hello");
	let other = await ask(proxy, "CONNECT example.org:443 HTTP/1.1\r\nhost: example.org:443\r\n\r\n");
	expect(other).toContain("HTTP/1.1 403 Forbidden");
	expect(other).toContain("example.org:443 is not on the allow list");
	let wrongPort = await ask(
		proxy,
		`CONNECT 127.0.0.1:${port + 1} HTTP/1.1\r\nhost: 127.0.0.1:${port + 1}\r\n\r\n`,
	);
	expect(wrongPort).toContain("403 Forbidden");
	// Each refused destination is said once, however often it is asked for.
	await ask(proxy, "CONNECT example.org:443 HTTP/1.1\r\n\r\n");
	expect(refused).toEqual(["example.org:443", `127.0.0.1:${port + 1}`]);
});

test("a plain HTTP request to a listed host is forwarded, and one to another is refused", async () => {
	let port = listener("page");
	let proxy = await startProxy({ hosts: [`127.0.0.1:${port}`] });
	proxies.push(proxy);
	let answer = await ask(
		proxy,
		`GET http://127.0.0.1:${port}/x?y=1 HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nproxy-connection: keep-alive\r\n\r\n`,
	);
	expect(answer).toContain("HTTP/1.1 200 OK");
	expect(answer).toEndWith("page");
	let refused = await ask(proxy, "GET http://example.org/ HTTP/1.1\r\nhost: example.org\r\n\r\n");
	expect(refused).toContain("403 Forbidden");
	let nonsense = await ask(proxy, "GET /not-a-proxy-request HTTP/1.1\r\n\r\n");
	expect(nonsense).toContain("400 Bad Request");
});

/** A masked client frame, as RFC 6455 has a client send one: a text message of under 126 bytes. */
function textFrame(text: string) {
	let payload = Buffer.from(text);
	let mask = [1, 2, 3, 4];
	let masked = Buffer.alloc(payload.length);
	for (let index = 0; index < payload.length; index++) {
		masked[index] = payload[index]! ^ mask[index % 4]!;
	}
	return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, ...mask]), masked]);
}

/** Send `head` to the proxy, then a frame once it has said 101, and collect what comes back. */
function upgrade(proxy: Proxy, head: string, frame?: Buffer): Promise<Buffer> {
	return new Promise(done => {
		let socket = connect(proxy.port, "127.0.0.1");
		let said = Buffer.alloc(0);
		let sent = false;
		socket.on("connect", () => socket.write(head));
		socket.on("data", (chunk: Buffer) => {
			said = Buffer.concat([said, chunk]);
			if (frame && !sent && said.includes("\r\n\r\n") && said.includes(" 101 ")) {
				sent = true;
				socket.write(frame);
			}
			// A frame the server sent back is a short one that follows the head.
			let end = said.indexOf("\r\n\r\n");
			if (end >= 0 && said.length > end + 4 + 2 && said.includes(" 101 ")) socket.end();
		});
		socket.on("close", () => done(said));
		setTimeout(() => socket.destroy(), 3000);
	});
}

test("a WebSocket upgrade sent as a plain request, without CONNECT, reaches a listed server and its frames pass both ways", async () => {
	// What the server was sent as headers: it takes an upgrade only from a request that asks for one.
	let asked: Array<{ connection: string | null; upgrade: string | null }> = [];
	let echo = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			asked.push({
				connection: request.headers.get("connection"),
				upgrade: request.headers.get("upgrade"),
			});
			return server.upgrade(request) ? undefined : new Response("not a socket", { status: 426 });
		},
		websocket: {
			message(socket, message) {
				socket.send(`echo:${message}`);
			},
		},
	});
	let port = echo.port!;
	try {
		let proxy = await startProxy({ hosts: [`127.0.0.1:${port}`] });
		proxies.push(proxy);
		let key = Buffer.from("0123456789abcdef").toString("base64");
		let head = (scheme: string) =>
			`GET ${scheme}://127.0.0.1:${port}/socket?a=1 HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\n`
			+ `upgrade: websocket\r\nconnection: keep-alive, Upgrade\r\nproxy-connection: keep-alive\r\n`
			+ `sec-websocket-key: ${key}\r\nsec-websocket-version: 13\r\n\r\n`;
		for (let scheme of ["http", "ws"]) {
			let said = await upgrade(proxy, head(scheme), textFrame("hello"));
			let text = said.toString("latin1");
			expect(text, `${scheme} upgrade`).toStartWith("HTTP/1.1 101 ");
			expect(text.toLowerCase()).toContain("upgrade: websocket");
			let accept = new Bun.CryptoHasher("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
			expect(text).toContain(accept);
			// The server's reply is an unmasked frame: text, 10 bytes, "echo:hello".
			expect(said.subarray(said.indexOf("\r\n\r\n") + 4).toString("latin1")).toBe(
				"\x81\x0aecho:hello",
			);
			// The proxy sent on the two headers an upgrade is made of, not the client's own keep-alive.
			expect(asked.at(-1)).toEqual({ connection: "Upgrade", upgrade: "websocket" });
		}
		// A request that isn't an upgrade is still sent on once and closed.
		let plain = await ask(
			proxy,
			`GET http://127.0.0.1:${port}/socket HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: keep-alive\r\n\r\n`,
		);
		expect(plain).toContain("426");
		// The allow list holds for an upgrade as for any request.
		let off = await upgrade(proxy, head("http").replaceAll(`${port}`, `${port + 1}`));
		expect(off.toString("latin1")).toContain("403 Forbidden");
	} finally {
		echo.stop(true);
	}
});

test("a built-in name that leads to a private address is refused, unless the entry is a local one", async () => {
	let port = listener("inside");
	let proxy = await startProxy({
		hosts: [...allowedHosts("https://chopin.example.com"), "localhost:" + port],
		resolve: async () => ["127.0.0.1"],
	});
	proxies.push(proxy);
	for (let host of ["api.github.com", "registry.npmjs.org", "api.openai.com"]) {
		let rebound = await ask(proxy, `CONNECT ${host}:443 HTTP/1.1\r\nhost: ${host}:443\r\n\r\n`);
		expect(rebound, host).toContain("403 Forbidden");
		expect(rebound, host).toContain("resolves to a private address");
	}
	let local = await ask(
		proxy,
		`CONNECT localhost:${port} HTTP/1.1\r\nhost: localhost:${port}\r\n\r\n`,
		"hi",
	);
	expect(local).toContain("200 Connection Established");
	expect(local).toContain("inside:hi");
});

test("Chopin's own origin and the hosts the owner added are reached on a private network, and no other name that leads there is", async () => {
	let port = listener("private");
	let origin = `http://chopin.private.example:${port}`;
	let proxy = await startProxy({
		hosts: allowedHosts(origin, [`registry.corp.example:${port}`]),
		resolve: async () => ["127.0.0.1"],
	});
	proxies.push(proxy);
	for (let host of ["chopin.private.example", "registry.corp.example"]) {
		let tunnelled = await ask(
			proxy,
			`CONNECT ${host}:${port} HTTP/1.1\r\nhost: ${host}:${port}\r\n\r\n`,
			"hi",
		);
		expect(tunnelled, host).toContain("200 Connection Established");
		expect(tunnelled, host).toContain("private:hi");
	}
	// A plain request to the origin is forwarded as well.
	let page = await ask(
		proxy,
		`GET http://chopin.private.example:${port}/ HTTP/1.1\r\nhost: chopin.private.example:${port}\r\n\r\n`,
	);
	expect(page).toContain("200 OK");
	// What the owner did not add is still refused, listed by the built-in lists or not.
	let github = await ask(proxy, "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n");
	expect(github).toContain("resolves to a private address");
	let unlisted = await ask(
		proxy,
		`CONNECT other.private.example:${port} HTTP/1.1\r\nhost: other.private.example:${port}\r\n\r\n`,
	);
	expect(unlisted).toContain("is not on the allow list");
});

test("an address of this machine or its networks is private; a public one is not", () => {
	for (
		let address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"::1",
			"fe80::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		]
	) {
		expect(privateAddress(address)).toBe(true);
	}
	for (let address of ["140.82.112.3", "172.32.0.1", "8.8.8.8", "2606:4700::1111"]) {
		expect(privateAddress(address)).toBe(false);
	}
});
