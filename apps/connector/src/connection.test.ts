import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveWork } from "./connection";
import { SELF } from "./machine";
import { remote } from "./mcp";
import { createOutput } from "./output";

type Tool = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * A fake Chopin connector endpoint; a tool that throws answers as an MCP tool error. With `token`,
 * any other bearer is refused as a restarted server refuses a connection it forgot.
 */
function chopin(tools: Record<string, Tool>, port = 0, token?: string) {
	let calls: string[] = [];
	/** The ids of requests the connector cancelled. */
	let cancelled: unknown[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			let message = await request.clone().json().catch(() => undefined) as
				| { method?: string; params?: { requestId?: unknown } }
				| undefined;
			if (message?.method === "notifications/cancelled") cancelled.push(message.params?.requestId);
			if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
				return Response.json({ error: "connection-unavailable" }, { status: 409 });
			}
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
	return { server, calls, cancelled, url: `http://127.0.0.1:${server.port}` };
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
		}, `This machine is no longer paired with Chopin. Run \`${SELF} pair\`, then connect again.`],
		[
			() => {
				throw new Error("machine-reauthorize: rejected");
			},
			`GitHub no longer accepts this machine's authorization. Run \`${SELF} pair\` to authorize it`,
		],
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
	})).rejects.toThrow(`Run \`${SELF} pair\`, then connect again.`);
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

test("Ctrl-C while Chopin withholds its handshake exits at once", async () => {
	let entered = Promise.withResolvers<void>();
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			entered.resolve();
			await new Promise(resolve => request.signal.addEventListener("abort", resolve));
			return new Response(null, { status: 503 });
		},
	});
	servers.push(server);
	let abort = new AbortController();
	let serving = serveWork({
		connect: signal => remote(`http://127.0.0.1:${server.port}`, "token", signal),
		signal: abort.signal,
		output: terminal().output,
		run: async () => {},
	});
	await entered.promise;
	let started = performance.now();
	abort.abort();
	await serving;
	expect(performance.now() - started).toBeLessThan(1000);
});

test("Ctrl-C while a claim is withheld exits at once and gives the work back", async () => {
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let fake = chopin({
		wait_for_work: () => ({ id: "work-1", kind: "experiment" }),
		claim_experiment: async () => {
			entered.resolve();
			await release.promise;
			return { claimed: "work-1" };
		},
	});
	let abort = new AbortController();
	let ran = 0;
	let serving = serveWork({
		connect: signal => remote(fake.url, "token", signal),
		signal: abort.signal,
		output: terminal().output,
		run: async () => void ran++,
	});
	await entered.promise;
	let started = performance.now();
	abort.abort();
	await serving;
	expect(performance.now() - started).toBeLessThan(1000);
	release.resolve();
	await Bun.sleep(50);
	expect(ran).toBe(0);
	// Leaving interrupts whatever the server handed this connection meanwhile.
	expect(fake.calls).toEqual(["wait_for_work", "claim_experiment", "disconnect_workspace"]);
});

test("hours of long polls on one signal leave no listeners on it, and Ctrl-C cancels only the last", async () => {
	let polls = 0;
	let holding = Promise.withResolvers<void>();
	let fake = chopin({
		wait_for_work: () => {
			if (++polls <= 200) return {};
			holding.resolve();
			return new Promise(() => {});
		},
	});
	let abort = new AbortController();
	let serving = serveWork({
		connect: signal => remote(fake.url, "token", signal),
		signal: abort.signal,
		output: terminal().output,
		run: async () => {},
	});
	await holding.promise;
	// Only the poll in flight listens; the 200 that were answered have let go.
	expect(getEventListeners(abort.signal, "abort")).toHaveLength(1);
	abort.abort();
	await serving;
	await Bun.sleep(100);
	expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
	// At most the poll in flight is cancelled; leaving may close the connection before it lands.
	expect(fake.cancelled.length).toBeLessThanOrEqual(1);
});

test("a claim answered after Ctrl-C is given back, not run", async () => {
	let abort = new AbortController();
	let calls: string[] = [];
	let ran = 0;
	await serveWork({
		// A link that answers even after its signal aborted, as a reply already on the wire does.
		connect: async () =>
			({
				close: async () => {},
				tools: async () => ({ tools: [] }),
				invoke: async () => ({ content: [] }),
				async call(name: string) {
					calls.push(name);
					if (name === "wait_for_work") return { id: "work-1", kind: "experiment" };
					if (name === "claim_experiment") abort.abort();
					return {};
				},
			}) as unknown as Awaited<ReturnType<typeof remote>>,
		signal: abort.signal,
		output: terminal().output,
		run: async () => void ran++,
	});
	expect(ran).toBe(0);
	expect(calls).toEqual(["wait_for_work", "claim_experiment", "disconnect_workspace"]);
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

test("a run's reports reach a restarted server through a fresh connection", async () => {
	let first = chopin({
		wait_for_work: () => ({ id: "work-1", kind: "experiment" }),
		claim_experiment: () => ({}),
	});
	let port = first.server.port;
	let abort = new AbortController();
	let connects = 0;
	let second: ReturnType<typeof chopin> | undefined;
	let attempts: string[] = [];
	await serveWork({
		// Each connection registers anew and gets its own token, as after a server restart.
		connect: () => remote(first.url, `token-${++connects}`),
		signal: abort.signal,
		output: terminal().output,
		async run(api) {
			await first.server.stop(true);
			second = chopin({ renew_experiment: () => ({ accepted: true }) }, port, "token-2");
			// The first renewal still goes to the connection the server forgot.
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await api.call("renew_experiment", { id: "work-1" });
					attempts.push("ok");
				} catch {
					attempts.push("failed");
				}
			}
			abort.abort();
		},
	});
	expect(attempts).toEqual(["failed", "ok"]);
	expect(connects).toBe(2);
	expect(second!.calls).toEqual(["renew_experiment", "disconnect_workspace"]);
});

test("a run's call that waits for a new connection gives up when its signal aborts", async () => {
	let first = chopin({
		wait_for_work: () => ({ id: "work-1", kind: "experiment" }),
		claim_experiment: () => ({}),
		renew_experiment: () => {
			throw new Error("unavailable: restarting");
		},
	});
	let connects = 0;
	let abort = new AbortController();
	let elapsed = 0;
	await serveWork({
		// The server accepts the reconnect but never answers it.
		connect: () => ++connects === 1 ? remote(first.url, "token") : new Promise(() => {}),
		signal: abort.signal,
		output: terminal().output,
		async run(api) {
			// A transient failure drops the connection, so the next call connects again.
			await api.call("renew_experiment", { id: "work-1" }).catch(() => {});
			let started = performance.now();
			let call = api.call("renew_experiment", { id: "work-1" }, AbortSignal.timeout(100));
			await expect(call).rejects.toThrow();
			elapsed = performance.now() - started;
			abort.abort();
		},
	});
	expect(connects).toBe(2);
	expect(elapsed).toBeLessThan(500);
});

/** A server that answers every request with one HTTP refusal. */
function refusing(status: number, error: string) {
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ error }, { status }),
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

test("a restarted server that no longer knows the connection stops it within two minutes", async () => {
	let url = refusing(409, "connection-unavailable");
	let clock = 0;
	let { output } = terminal();
	await expect(serveWork({
		connect: () => remote(url, "token"),
		signal: new AbortController().signal,
		output,
		random: () => 0.999_999,
		now: () => clock,
		async sleep(ms) {
			clock += ms;
		},
		run: async () => {},
	})).rejects.toThrow("Chopin no longer recognizes this connection (it may have restarted).");
	expect(clock).toBe(120_000);
});

test("a server answering 503 keeps the connector retrying past two minutes", async () => {
	let url = refusing(503, "unavailable");
	let abort = new AbortController();
	let clock = 0;
	await serveWork({
		connect: () => remote(url, "token"),
		signal: abort.signal,
		output: terminal().output,
		random: () => 0.999_999,
		now: () => clock,
		async sleep(ms) {
			clock += ms;
			if (clock > 600_000) abort.abort();
		},
		run: async () => {},
	});
	expect(clock).toBeGreaterThan(600_000);
});
