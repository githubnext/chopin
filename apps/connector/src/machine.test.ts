import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseArgs } from "./args";
import { classifyConnectorError, connectorMessage, machineFile, pair } from "./machine";
import { createOutput } from "./output";
import { ConnectorError } from "./mcp";
import { git, stateDirectory } from "./workspace";

const MACHINE_TOKEN = `chopin_m_${"T".repeat(43)}`;
const MAIN = join(import.meta.dir, "main.ts");

let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (let step of cleanup.splice(0).toReversed()) await step();
});

async function scratch(prefix: string) {
	let path = await mkdtemp(join(tmpdir(), prefix));
	cleanup.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

async function checkout() {
	let root = await scratch("chopin-machine-checkout-");
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "file.txt"), "x");
	git(root, "add", ".");
	git(root, "commit", "-m", "fixture");
	return root;
}

/** A Chopin server that pairs, registers checkouts and serves wait_for_work, recording calls. */
function fakeChopin(options: { connections?: () => Response } = {}) {
	let calls: Array<{ path: string; bearer: string; body: unknown }> = [];
	let waited = Promise.withResolvers<void>();
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			let path = new URL(request.url).pathname;
			let bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			if (path !== "/connector/mcp") {
				let body = request.method === "POST"
					? await request.json().catch(() => undefined)
					: undefined;
				calls.push({ path, bearer, body });
			}
			if (path === "/api/connector/pairings") {
				return Response.json({
					id: "pairing",
					secret: "s".repeat(43),
					url: `http://127.0.0.1:${server.port}/connect?pairing=pairing`,
					code: "ABCD-EFGH",
				});
			}
			if (path === "/api/connector/pairings/pairing/claim") {
				return Response.json({ token: MACHINE_TOKEN });
			}
			if (path === "/api/connector/connections") {
				if (bearer !== MACHINE_TOKEN) {
					return Response.json({ error: "machine-revoked" }, { status: 401 });
				}
				return options.connections?.() ?? Response.json({ token: "connection-token" });
			}
			if (path === "/api/connector/machine/revoke") {
				return bearer === MACHINE_TOKEN
					? Response.json({ revoked: true })
					: Response.json({ error: "machine-revoked" }, { status: 401 });
			}
			if (path !== "/connector/mcp" || bearer !== "connection-token") {
				return new Response(null, { status: 401 });
			}
			let mcp = new Server({ name: "fake-chopin", version: "1" }, { capabilities: { tools: {} } });
			mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
			mcp.setRequestHandler(CallToolRequestSchema, async request => {
				calls.push({ path: `tool:${request.params.name}`, bearer, body: undefined });
				if (request.params.name === "wait_for_work") {
					waited.resolve();
					await Bun.sleep(100);
				}
				return { content: [{ type: "text", text: "{}" }] };
			});
			let transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await mcp.connect(transport);
			return transport.handleRequest(request);
		},
	});
	cleanup.push(() => server.stop(true));
	return { url: `http://127.0.0.1:${server.port}`, calls, waited: waited.promise };
}

function cli(args: string[], home: string, url: string) {
	let child = Bun.spawn([process.execPath, MAIN, ...args], {
		env: { ...process.env, CHOPIN_URL: url, CHOPIN_HOME: home, CHOPIN_CONNECTOR_STATE_DIR: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	cleanup.push(() => child.kill("SIGKILL"));
	let output = (async () => {
		let [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return stdout + stderr;
	})();
	return { child, output, exited: child.exited };
}

test("pair stores the machine token at 0600 beside its server, and never prints it", async () => {
	let home = await scratch("chopin-home-");
	let chopin = fakeChopin();
	let paired = cli(["pair", "--label", "build-box"], home, chopin.url);
	expect(await paired.exited).toBe(0);
	let output = await paired.output;
	expect(output).toContain("ABCD-EFGH");
	expect(output).not.toContain(MACHINE_TOKEN);
	expect(chopin.calls[0]).toMatchObject({
		path: "/api/connector/pairings",
		body: { label: "build-box" },
	});
	let file = join(home, "machine.json");
	if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
		servers: { [chopin.url]: { token: MACHINE_TOKEN, label: "build-box" } },
	});
});

function quietPair(url: string, label: string, directory: string) {
	let sink = { write: () => true };
	return pair({
		url,
		label,
		directory,
		output: createOutput(sink, sink, {}),
		signal: new AbortController().signal,
	});
}

test("two connectors pairing different servers at once both keep their tokens", async () => {
	let home = await scratch("chopin-home-");
	let first = fakeChopin();
	let second = fakeChopin();
	// Each read of machine.json is slow, so both pairings read it before either writes.
	let read = fs.readFile;
	let slow = spyOn(fs, "readFile").mockImplementation(
		(async (...args: Parameters<typeof read>) => {
			await Bun.sleep(50);
			return read(...args);
		}) as typeof read,
	);
	cleanup.push(() => slow.mockRestore());
	await Promise.all([
		quietPair(first.url, "first", home),
		quietPair(second.url, "second", home),
	]);
	slow.mockRestore();
	expect(JSON.parse(await readFile(machineFile(home), "utf8"))).toEqual({
		servers: {
			[first.url]: { token: MACHINE_TOKEN, label: "first" },
			[second.url]: { token: MACHINE_TOKEN, label: "second" },
		},
	});
	expect(await Bun.file(`${machineFile(home)}.lock`).exists()).toBe(false);
});

test("pairing replaces a lock left by a connector that died or hung", async () => {
	let home = await scratch("chopin-home-");
	let chopin = fakeChopin();
	let lock = `${machineFile(home)}.lock`;
	let gone = Bun.spawn([process.execPath, "-e", ""]);
	await gone.exited;
	let stale = [
		// Windows cannot tell whether the process lives, so it relies on the lock's age alone.
		...(process.platform === "win32" ? [] : [{ pid: gone.pid, time: Date.now() }]),
		{ pid: process.pid, time: Date.now() - 60_000 },
	];
	for (let held of stale) {
		await writeFile(lock, JSON.stringify(held), { mode: 0o600 });
		let started = Date.now();
		expect(await quietPair(chopin.url, "box", home)).toBe(MACHINE_TOKEN);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await Bun.file(lock).exists()).toBe(false);
	}
});

test("connect reuses a stored machine token without pairing again", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
	chopin.calls.length = 0;
	let connected = cli(["connect", root, "--", "agent-that-never-runs"], home, chopin.url);
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	let output = await connected.output;
	expect(output).not.toContain(MACHINE_TOKEN);
	expect(chopin.calls.map(call => call.path)).not.toContain("/api/connector/pairings");
	expect(chopin.calls[0]).toMatchObject({
		path: "/api/connector/connections",
		bearer: MACHINE_TOKEN,
		body: { repository: "octo-org/score" },
	});
	expect(chopin.calls.map(call => call.path)).toContain("tool:wait_for_work");
});

test("connect pairs first when this machine has no token for the server", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	let connected = cli(["connect", root, "--", "agent-that-never-runs"], home, chopin.url);
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	expect(chopin.calls.map(call => call.path).slice(0, 3)).toEqual([
		"/api/connector/pairings",
		"/api/connector/pairings/pairing/claim",
		"/api/connector/connections",
	]);
	expect(chopin.calls[0]!.body).toMatchObject({ repository: "octo-org/score" });
	expect(JSON.parse(await readFile(join(home, "machine.json"), "utf8")).servers[chopin.url].token)
		.toBe(MACHINE_TOKEN);
});

test("a revoked machine stops connect at once and says to pair again", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin({
		connections: () => Response.json({ error: "machine-revoked" }, { status: 401 }),
	});
	expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
	chopin.calls.length = 0;
	let connected = cli(["connect", root, "--", "agent"], home, chopin.url);
	expect(await connected.exited).toBe(1);
	let output = await connected.output;
	expect(output).toContain("no longer paired");
	expect(output).toMatch(/pair`/);
	expect(chopin.calls.map(call => call.path)).toEqual(["/api/connector/connections"]);
});

test("unpair revokes the machine on the server and deletes the local token", async () => {
	let home = await scratch("chopin-home-");
	let chopin = fakeChopin();
	expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
	let unpaired = cli(["unpair"], home, chopin.url);
	expect(await unpaired.exited).toBe(0);
	expect(await unpaired.output).not.toContain(MACHINE_TOKEN);
	expect(chopin.calls.at(-1)).toMatchObject({
		path: "/api/connector/machine/revoke",
		bearer: MACHINE_TOKEN,
	});
	expect(JSON.parse(await readFile(join(home, "machine.json"), "utf8"))).toEqual({ servers: {} });
	// Unpairing again has nothing left to revoke.
	let again = cli(["unpair"], home, chopin.url);
	expect(await again.exited).toBe(0);
	expect(await again.output).toContain("not paired");
});

test("connector errors are classified so a reconnect loop stops on revocation", () => {
	expect(classifyConnectorError(new ConnectorError("machine-revoked", "gone"))).toBe("revoked");
	expect(classifyConnectorError(new ConnectorError("machine-reauthorize", "pair"))).toBe("revoked");
	expect(classifyConnectorError(new ConnectorError("connector-update-required", "update")))
		.toBe("update-required");
	// A restarted server forgot the connection: retried for a while, as registering again helps.
	expect(classifyConnectorError(new ConnectorError("connection-unavailable", "restart")))
		.toBe("forgotten");
	expect(classifyConnectorError(new ConnectorError("owner-sign-in-required", "sign in")))
		.toBe("retry");
	expect(classifyConnectorError(new ConnectorError("repository-forbidden", "no"))).toBe("fatal");
	expect(classifyConnectorError(new TypeError("fetch failed"))).toBe("retry");
	expect(
		classifyConnectorError(
			new StreamableHTTPError(401, 'Error POSTing to endpoint: {"error":"machine-revoked"}'),
		),
	).toBe("revoked");
	expect(classifyConnectorError(new StreamableHTTPError(502, "Bad gateway"))).toBe("retry");
	// A connection revoked mid-run reports through a tool error, and still says what to do.
	expect(
		connectorMessage(new ConnectorError("machine-revoked", "machine-revoked: machine-revoked")),
	)
		.toContain("pair`");
	expect(
		classifyConnectorError(
			new StreamableHTTPError(409, 'Error POSTing to endpoint: {"error":"connection-unavailable"}'),
		),
	).toBe("forgotten");
});

test("every command takes --base-dir, which moves the state directory", () => {
	let previous = process.env.CHOPIN_HOME;
	try {
		let parsed = parseArgs([
			"--base-dir",
			"relative/home",
			"--label=box",
			"checkout",
			"--",
			"a",
			"--b",
		], {
			options: ["label"],
		});
		expect(parsed.positional).toEqual(["checkout"]);
		expect(parsed.options.get("label")).toBe("box");
		expect(parsed.rest).toEqual(["a", "--b"]);
		expect(stateDirectory()).toBe(join(process.cwd(), "relative/home"));
		expect(() => parseArgs(["--nope"])).toThrow("Unknown option: --nope");
		expect(() => parseArgs(["--base-dir"])).toThrow("--base-dir needs a value.");
	} finally {
		if (previous === undefined) delete process.env.CHOPIN_HOME;
		else process.env.CHOPIN_HOME = previous;
	}
});
