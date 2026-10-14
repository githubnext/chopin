import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseArgs } from "./args";
import { updateConfig } from "./config";
import { classifyConnectorError, connectorMessage, machineFile, pair } from "./machine";
import { createOutput } from "./output";
import { ConnectorError } from "./mcp";
import { git, stateDirectory } from "./workspace";

const MACHINE_TOKEN = `chopin_m_${"T".repeat(43)}`;
const PAIRING_KEY = `chopin_k_${"K".repeat(43)}`;
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

/**
 * A Chopin server that pairs, registers checkouts and serves wait_for_work, recording calls. It
 * refuses any machine token but the one it paired with `stale`, machine-revoked by default. It
 * takes PAIRING_KEY once.
 */
function fakeChopin(options: { connections?: () => Response; stale?: string } = {}) {
	let calls: Array<
		{ path: string; bearer: string; body: unknown; about?: Record<string, string> }
	> = [];
	let waited = Promise.withResolvers<void>();
	let spent = false;
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
				let about = Object.fromEntries(
					[...request.headers].filter(([name]) =>
						/^chopin-connector-(host|platform|service|planner|agent)/.test(name)
					),
				);
				calls.push({ path, bearer, body, ...(Object.keys(about).length ? { about } : {}) });
			}
			if (path === "/api/connector/pairings") {
				let key = (calls.at(-1)!.body as { key?: string }).key;
				if (key !== undefined) {
					if (key !== PAIRING_KEY || spent) {
						return Response.json({ error: "pairing-key-invalid" }, { status: 403 });
					}
					spent = true;
					return Response.json({ token: MACHINE_TOKEN });
				}
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
					return Response.json({ error: options.stale ?? "machine-revoked" }, { status: 401 });
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

/** Agents the connects below name; chopin finds them before it pairs, and they never run. */
const PROGRAMS = await mkdtemp(join(tmpdir(), "chopin-machine-programs-"));
for (let name of ["agent", "agent-that-never-runs"]) {
	await writeFile(
		join(PROGRAMS, process.platform === "win32" ? `${name}.cmd` : name),
		"#!/bin/sh\n",
		{ mode: 0o755 },
	);
}
afterAll(() => rm(PROGRAMS, { recursive: true, force: true }));

function cli(args: string[], home: string, url: string, env: Record<string, string> = {}) {
	let child = Bun.spawn([process.execPath, MAIN, ...args], {
		env: {
			...process.env,
			CHOPIN_URL: url,
			CHOPIN_HOME: home,
			CHOPIN_CONNECTOR_STATE_DIR: "",
			...env,
			PATH: [env.PATH ?? process.env.PATH, PROGRAMS].join(delimiter),
		},
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
	// It says which machine it is, for its owner's list: no agent yet, as none has run here.
	expect(chopin.calls[0]!.about).toEqual({
		"chopin-connector-host": hostname(),
		"chopin-connector-platform": `${process.platform} ${process.arch}`,
	});
	expect(chopin.calls.map(call => call.path)).toContain("tool:wait_for_work");
});

test("connect names the agent it learned of at an earlier check or job, and the service", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
	await writeFile(
		join(home, "config.json"),
		JSON.stringify({
			agents: { "agent-that-never-runs": { name: "Never Runs", version: "2.0.1" } },
		}),
	);
	chopin.calls.length = 0;
	let connected = cli(["connect", root, "--", "agent-that-never-runs"], home, chopin.url);
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	expect(chopin.calls[0]!.about).toMatchObject({
		"chopin-connector-agent": "Never Runs",
		"chopin-connector-agent-version": "2.0.1",
	});
});

test.skipIf(process.platform === "win32")(
	"connect asks the agent its name and version as it connects, before any job, and tells Chopin",
	async () => {
		let home = await scratch("chopin-home-");
		let root = await checkout();
		let bin = await scratch("chopin-agent-bin-");
		let agent = join(import.meta.dir, "testing/fake-agent.ts");
		await writeFile(join(bin, "fake-acp"), `#!/bin/sh\nexec ${process.execPath} ${agent}\n`, {
			mode: 0o755,
		});
		let chopin = fakeChopin();
		expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
		chopin.calls.length = 0;
		let connected = cli(["connect", root, "--", "fake-acp"], home, chopin.url, {
			PATH: [bin, process.env.PATH].join(delimiter),
		});
		let reported = async () => chopin.calls.find(call => call.path === "/api/connector/agent");
		for (let deadline = Date.now() + 15_000; !await reported() && Date.now() < deadline;) {
			await Bun.sleep(50);
		}
		connected.child.kill("SIGINT");
		expect(await connected.exited, await connected.output).toBe(0);
		// No job ran; the connection's own probe learned it.
		expect(chopin.calls.map(call => call.path)).not.toContain("tool:claim_work");
		expect(await reported()).toEqual({
			path: "/api/connector/agent",
			bearer: "connection-token",
			body: { name: "Fake Agent", version: "1.2.3" },
		});
		// Kept for the next connection's headers.
		expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).agents).toEqual({
			"fake-acp": { name: "Fake Agent", version: "1.2.3" },
		});
	},
	30_000,
);

test("an agent that never answers ACP initialize doesn't hold up the connection", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let bin = await scratch("chopin-agent-bin-");
	await writeFile(join(bin, "silent-acp"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
	let chopin = fakeChopin();
	expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
	chopin.calls.length = 0;
	let connected = cli(["connect", root, "--", "silent-acp"], home, chopin.url, {
		PATH: [bin, process.env.PATH].join(delimiter),
	});
	let started = Date.now();
	await Promise.race([chopin.waited, connected.exited]);
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(chopin.calls.map(call => call.path)).toContain("tool:wait_for_work");
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	expect(chopin.calls.map(call => call.path)).not.toContain("/api/connector/agent");
}, 30_000);

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

/** Every file under `directory`, read whole, so a test can say a secret is in none of them. */
async function everything(directory: string) {
	let files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true }));
	return (await Promise.all(files.map(file => readFile(join(directory, file), "utf8")))).join("\n");
}

test("pair --key pairs at once, with no browser and no terminal, and keeps the key nowhere", async () => {
	let home = await scratch("chopin-home-");
	let chopin = fakeChopin();
	// Spawned without a terminal, as over plain SSH or under a service.
	let paired = cli(["pair", "--label", "build-box", "--key", PAIRING_KEY], home, chopin.url);
	expect(await paired.exited, await paired.output).toBe(0);
	let output = await paired.output;
	expect(output).toContain("✓ Paired.");
	expect(output).not.toContain("/connect?pairing=");
	expect(output).not.toContain(PAIRING_KEY);
	expect(chopin.calls).toEqual([
		{ path: "/api/connector/pairings", bearer: "", body: { label: "build-box", key: PAIRING_KEY } },
	]);
	expect(JSON.parse(await readFile(machineFile(home), "utf8"))).toEqual({
		servers: { [chopin.url]: { token: MACHINE_TOKEN, label: "build-box" } },
	});
	expect(await everything(home)).not.toContain(PAIRING_KEY);
});

test("connect takes the key from CHOPIN_PAIRING_KEY, pairs with no browser, and keeps it nowhere", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	let connected = cli(["connect", root, "--", "agent-that-never-runs"], home, chopin.url, {
		CHOPIN_PAIRING_KEY: PAIRING_KEY,
	});
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	let output = await connected.output;
	expect(output).not.toContain(PAIRING_KEY);
	expect(output).not.toContain("/connect?pairing=");
	expect(chopin.calls.map(call => call.path).slice(0, 2)).toEqual([
		"/api/connector/pairings",
		"/api/connector/connections",
	]);
	expect(chopin.calls[0]!.body).toMatchObject({ repository: "octo-org/score", key: PAIRING_KEY });
	expect(await everything(home)).not.toContain(PAIRING_KEY);
	expect(await everything(home)).toContain(MACHINE_TOKEN);
});

test("a refused pairing key stops with what to do instead of falling back to the browser", async () => {
	let home = await scratch("chopin-home-");
	let chopin = fakeChopin();
	let other = `chopin_k_${"O".repeat(43)}`;
	let refused = cli(["pair", "--key", other], home, chopin.url);
	expect(await refused.exited).toBe(1);
	let output = await refused.output;
	expect(output).toContain("Chopin refused the pairing key");
	expect(output).toContain("Add a machine");
	expect(output).not.toContain(other);
	expect(chopin.calls.map(call => call.path)).toEqual(["/api/connector/pairings"]);
	expect(await Bun.file(machineFile(home)).exists()).toBe(false);

	// Something that isn't a key at all is refused before Chopin is asked.
	chopin.calls.length = 0;
	let typo = cli(["pair", "--key", "chopin_m_not-a-key"], home, chopin.url);
	expect(await typo.exited).toBe(1);
	expect(await typo.output).toContain("isn't a pairing key");
	expect(chopin.calls).toEqual([]);
});

test("connect on a machine already paired leaves the pairing key unspent", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	expect(await cli(["pair"], home, chopin.url).exited).toBe(0);
	chopin.calls.length = 0;
	let connected = cli(
		["connect", root, "--key", PAIRING_KEY, "--", "agent-that-never-runs"],
		home,
		chopin.url,
	);
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	expect(await connected.output).toContain("already paired");
	expect(chopin.calls.map(call => call.path)).not.toContain("/api/connector/pairings");
});

test("connect --name names the machine it pairs, as pair --label does", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	let connected = cli(
		["connect", root, "--name", "build box", "--key", PAIRING_KEY, "--", "agent-that-never-runs"],
		home,
		chopin.url,
	);
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	expect(chopin.calls[0]).toMatchObject({
		path: "/api/connector/pairings",
		body: { label: "build box", key: PAIRING_KEY },
	});
	expect(JSON.parse(await readFile(machineFile(home), "utf8")).servers[chopin.url].label)
		.toBe("build box");
	expect(await connected.output).not.toContain("--name wasn't used");
});

test("connect --name on a machine already paired keeps its name and says where to rename it", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	expect(await cli(["pair", "--label", "old-name"], home, chopin.url).exited).toBe(0);
	chopin.calls.length = 0;
	let connected = cli(
		["connect", root, "--name", "new-name", "--", "agent-that-never-runs"],
		home,
		chopin.url,
	);
	await Promise.race([chopin.waited, connected.exited]);
	connected.child.kill("SIGINT");
	expect(await connected.exited, await connected.output).toBe(0);
	let output = await connected.output;
	expect(output).toContain("This machine is already paired with");
	expect(output).toContain("so --name wasn't used");
	expect(output).toContain("Machines page");
	expect(chopin.calls.map(call => call.path)).not.toContain("/api/connector/pairings");
	expect(JSON.parse(await readFile(machineFile(home), "utf8")).servers[chopin.url].label)
		.toBe("old-name");
});

test("a key given to connect with an agent that isn't installed is never sent, so it still works", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	let missing = cli(
		["connect", root, "--key", PAIRING_KEY, "--", "no-such-agent"],
		home,
		chopin.url,
	);
	expect(await missing.exited).toBe(1);
	expect(await missing.output).toContain("no-such-agent isn't on your PATH");
	expect(chopin.calls).toEqual([]);
	// The same key pairs once the agent is there.
	expect(await cli(["pair", "--key", PAIRING_KEY], home, chopin.url).exited).toBe(0);
});

const REVOKED_TOKEN = `chopin_m_${"R".repeat(43)}`;
const ELSEWHERE = "https://other-chopin.example";

/** A machine.json holding a token Chopin has revoked, beside another server's token. */
async function revokedMachine(home: string, url: string) {
	await writeFile(
		machineFile(home),
		JSON.stringify({
			servers: {
				[url]: { token: REVOKED_TOKEN, label: "box" },
				[ELSEWHERE]: { token: MACHINE_TOKEN, label: "box" },
			},
		}),
		{ mode: 0o600 },
	);
}

for (let code of ["machine-revoked", "machine-reauthorize"]) {
	test(`without a terminal, ${code} stops connect, says to pair again and forgets the token`, async () => {
		let home = await scratch("chopin-home-");
		let root = await checkout();
		let chopin = fakeChopin({ stale: code });
		await revokedMachine(home, chopin.url);
		let connected = cli(["connect", root, "--", "agent"], home, chopin.url);
		expect(await connected.exited).toBe(1);
		let output = await connected.output;
		expect(output).toContain(
			code === "machine-revoked" ? "no longer paired" : "authorize it again",
		);
		expect(output).toMatch(/pair`/);
		expect(chopin.calls.map(call => call.path)).toEqual(["/api/connector/connections"]);
		expect(JSON.parse(await readFile(machineFile(home), "utf8"))).toEqual({
			servers: { [ELSEWHERE]: { token: MACHINE_TOKEN, label: "box" } },
		});
	});
}

test("the service's connect, started again after its token was forgotten, stops without pairing", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	await revokedMachine(home, chopin.url);
	// The settings `chopin service install` copied, which the service runs.
	await updateConfig(home, value => {
		value.service = {
			executable: "/opt/chopin",
			directory: home,
			version: "0.0.1",
			installedAt: 1,
			settings: {
				server: chopin.url,
				checkout: root,
				command: ["agent"],
				planners: [],
				plannerCommand: [],
			},
		};
	});
	let revoked = cli(["connect", "--service"], home, chopin.url);
	expect(await revoked.exited).toBe(1);
	expect(await revoked.output).toContain("no longer paired");
	// The service manager starts it again, with no token stored and no terminal to pair on.
	let again = cli(["connect", "--service"], home, chopin.url);
	expect(await Promise.race([again.exited, Bun.sleep(3000).then(() => "still running")]))
		.toBe(1);
	let output = await again.output;
	expect(output).toContain(`This machine is not paired with ${chopin.url}.`);
	expect(output).toMatch(/pair` at a terminal/);
	expect(chopin.calls.map(call => call.path)).toEqual(["/api/connector/connections"]);
});

test("on a terminal, connect with a revoked token forgets it and pairs again", async () => {
	let home = await scratch("chopin-home-");
	let root = await checkout();
	let chopin = fakeChopin();
	await revokedMachine(home, chopin.url);
	let output = "";
	let child = Bun.spawn([process.execPath, MAIN, "connect", root, "--", "agent-that-never-runs"], {
		env: {
			...process.env,
			CHOPIN_URL: chopin.url,
			CHOPIN_HOME: home,
			CHOPIN_CONNECTOR_STATE_DIR: "",
			PATH: [process.env.PATH, PROGRAMS].join(delimiter),
		},
		terminal: {
			cols: 200,
			rows: 24,
			data(_terminal, data) {
				output += new TextDecoder().decode(data);
			},
		},
	});
	cleanup.push(() => {
		child.kill("SIGKILL");
		child.terminal?.close();
	});
	await Promise.race([chopin.waited, child.exited]);
	child.kill("SIGINT");
	expect(await child.exited, output).toBe(0);
	expect(output).toContain("ABCD-EFGH");
	expect(chopin.calls.map(call => [call.path, call.bearer]).slice(0, 4)).toEqual([
		["/api/connector/connections", REVOKED_TOKEN],
		["/api/connector/pairings", ""],
		["/api/connector/pairings/pairing/claim", ""],
		["/api/connector/connections", MACHINE_TOKEN],
	]);
	expect(JSON.parse(await readFile(machineFile(home), "utf8"))).toEqual({
		servers: {
			[chopin.url]: { token: MACHINE_TOKEN, label: hostname() },
			[ELSEWHERE]: { token: MACHINE_TOKEN, label: "box" },
		},
	});
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
