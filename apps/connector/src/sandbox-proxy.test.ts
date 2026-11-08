import { afterAll, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
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

test("a listed name that leads to a private address is refused, unless the entry is a local one", async () => {
	let port = listener("inside");
	let proxy = await startProxy({
		hosts: ["listed.example.com:" + port, "localhost:" + port],
		resolve: async () => ["127.0.0.1"],
	});
	proxies.push(proxy);
	let rebound = await ask(
		proxy,
		`CONNECT listed.example.com:${port} HTTP/1.1\r\nhost: listed.example.com:${port}\r\n\r\n`,
	);
	expect(rebound).toContain("403 Forbidden");
	expect(rebound).toContain("resolves to a private address");
	let local = await ask(
		proxy,
		`CONNECT localhost:${port} HTTP/1.1\r\nhost: localhost:${port}\r\n\r\n`,
		"hi",
	);
	expect(local).toContain("200 Connection Established");
	expect(local).toContain("inside:hi");
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
