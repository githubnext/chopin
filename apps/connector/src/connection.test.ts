import { afterEach, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveWork } from "./connection";
import { remote } from "./mcp";
import { createOutput } from "./output";

type Tool = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** A fake Chopin connector endpoint; a tool that throws answers as an MCP tool error. */
function chopin(tools: Record<string, Tool>, port = 0) {
	let calls: string[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			let mcp = new Server({ name: "fake-chopin", version: "1" }, { capabilities: { tools: {} } });
			mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
			mcp.setRequestHandler(CallToolRequestSchema, async request => {
				let name = request.params.name;
				calls.push(name);
				try {
					let value = await (tools[name] ?? (() => ({})))(request.params.arguments ?? {});
					return { content: [{ type: "text", text: JSON.stringify(value) }] };
				} catch (error) {
					return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
				}
			});
			let transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await mcp.connect(transport);
			return transport.handleRequest(request);
		},
	});
	servers.push(server);
	return { server, calls, url: `http://127.0.0.1:${server.port}` };
}
let servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
	await Promise.all(servers.map(server => server.stop(true)));
	servers = [];
});

function terminal() {
	let text = "";
	let stream = { isTTY: false, write: (value: string) => text += value };
	return { output: createOutput(stream, stream, {}), text: () => text };
}

test("a server restart mid-wait reconnects after a backoff and receives the next work", async () => {
	let waiting = Promise.withResolvers<void>();
	let first = chopin({
		wait_for_work: () => {
			waiting.resolve();
			return new Promise(() => {});
		},
	});
	let port = first.server.port;
	let second: ReturnType<typeof chopin> | undefined;
	let abort = new AbortController();
	let delays: number[] = [];
	let ran: unknown[] = [];
	let { output, text } = terminal();
	let serving = serveWork({
		connect: () => remote(first.url, "token"),
		signal: abort.signal,
		output,
		random: () => 0.5,
		async sleep(ms) {
			delays.push(ms);
			// The server is back once the connector starts backing off.
			second ??= chopin({
				wait_for_work: () => ({ id: "work-1", kind: "experiment" }),
				claim_experiment: args => ({ claimed: args.id }),
			}, port);
		},
		async run(_api, kind, claim) {
			ran.push([kind, claim]);
			abort.abort();
		},
	});
	await waiting.promise;
	await first.server.stop(true);
	await serving;
	expect(ran).toEqual([["experiment", { claimed: "work-1" }]]);
	// The drop retried at once; the refused retry then backed off before the server came back.
	expect(delays).toEqual([500]);
	expect(second!.calls).toEqual(["wait_for_work", "claim_experiment", "disconnect_workspace"]);
	expect(text()).toContain("Lost the connection to Chopin");
	expect(text()).toContain("Reconnecting in 1s");
	expect(text()).toContain("✓ Reconnected.");
});

test("revocation, an upgrade and lost access stop at once with a message for the terminal", async () => {
	let refusals: Array<[Tool, string]> = [
		[() => {
			throw new Error("machine-revoked: revoked");
		}, "This machine is no longer paired with Chopin. Run `chopin pair`, then connect again."],
		[() => {
			throw new Error("machine-reauthorize: rejected");
		}, "GitHub no longer accepts this machine's authorization. Run `chopin pair` to authorize it"],
		[() => {
			throw new Error("connector-update-required: protocol 1 is too old");
		}, "This Chopin server needs a newer connector. Update it, then connect again."],
		[() => {
			throw new Error("repository-forbidden: repository-forbidden");
		}, "Chopin refused the connection: you no longer have push access to this repository."],
	];
	for (let [refuse, message] of refusals) {
		let fake = chopin({ wait_for_work: refuse });
		let slept = 0;
		let { output } = terminal();
		await expect(serveWork({
			connect: () => remote(fake.url, "token"),
			signal: new AbortController().signal,
			output,
			sleep: async () => void slept++,
			run: async () => {},
		})).rejects.toThrow(message);
		expect(slept).toBe(0);
		expect(fake.calls).toEqual(["wait_for_work"]);
	}
});

test("a refused HTTP call for a revoked machine stops without retrying", async () => {
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ error: "machine-revoked" }, { status: 401 }),
	});
	servers.push(server);
	let { output } = terminal();
	await expect(serveWork({
		connect: () => remote(`http://127.0.0.1:${server.port}`, "token"),
		signal: new AbortController().signal,
		output,
		sleep: () => Promise.reject(new Error("retried")),
		run: async () => {},
	})).rejects.toThrow("Run `chopin pair`, then connect again.");
});

test("Ctrl-C while backing off exits at once", async () => {
	let abort = new AbortController();
	let { output, text } = terminal();
	let started = performance.now();
	let serving = serveWork({
		// Nothing listens on port 1, so every attempt is refused.
		connect: () => remote("http://127.0.0.1:1", "token"),
		signal: abort.signal,
		output,
		random: () => 0.999,
		run: async () => {},
	});
	while (!text().includes("Reconnecting in")) await Bun.sleep(5);
	abort.abort();
	await serving;
	expect(performance.now() - started).toBeLessThan(500);
});

test("retries back off, are announced only at first, and start over after a minute up", async () => {
	let abort = new AbortController();
	let clock = 0;
	let delays: number[] = [];
	// How long each successful connection stays up before its long poll fails.
	let uptimes = [3_600_000, 1000];
	let fake = chopin({
		wait_for_work: async () => {
			let uptime = uptimes.shift();
			if (uptime === undefined) abort.abort();
			else clock += uptime;
			throw new Error("unavailable: restarting");
		},
	});
	// Attempts in order: refused (x) or let through (o).
	let script = [..."xxxo", ..."xxo", ..."xxxxxo"];
	let { output, text } = terminal();
	await serveWork({
		async connect() {
			if (script.shift() === "x") {
				throw Object.assign(new TypeError("Unable to connect."), { code: "ConnectionRefused" });
			}
			return remote(fake.url, "token");
		},
		signal: abort.signal,
		output,
		random: () => 0.999_999,
		now: () => clock,
		async sleep(ms) {
			delays.push(ms);
			clock += ms;
		},
		run: async () => {},
	});
	expect(delays).toEqual([
		// Unreachable at start: the ladder climbs.
		999,
		1_999,
		3_999,
		// Up for an hour, then dropped: once at once, then the ladder from its start.
		999,
		1_999,
		// Up for a second only: the ladder keeps climbing.
		3_999,
		7_999,
		15_999,
		31_999,
		63_999,
		127_999,
	]);
	let lines = text().split("\n");
	expect(lines.filter(line => line.includes("Can't reach Chopin"))).toHaveLength(1);
	expect(lines.filter(line => line.includes("Lost the connection"))).toHaveLength(2);
	// Three announcements per outage, then one line saying it keeps trying.
	expect(lines.filter(line => line.includes("Reconnecting"))).toHaveLength(9);
	expect(lines.filter(line => line.includes("Still reconnecting"))).toHaveLength(1);
	expect(lines.filter(line => line.includes("Reconnected"))).toHaveLength(3);
});
