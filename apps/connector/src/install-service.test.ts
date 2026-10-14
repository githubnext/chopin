import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readConfig } from "./config";
import { connect } from "./main";
import type { Outcome, ServiceHost } from "./service";
import { git } from "./workspace";

/**
 * `chopin connect --install-service` in this process, against a fake Chopin, with a service
 * manager runner that records every call instead of running systemctl or loginctl.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-install-service-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const PAIRING_KEY = `chopin_k_${"K".repeat(43)}`;

async function setup(
	answer: (line: string) => Partial<Outcome> | undefined,
	{ paired = true } = {},
) {
	let tools: string[] = [];
	let requests: string[] = [];
	let chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let path = new URL(request.url).pathname;
			requests.push(path);
			if (path === "/api/connector/pairings") {
				let { key } = await request.json() as { key?: string };
				return key === PAIRING_KEY
					? Response.json({ token: `chopin_m_${"M".repeat(43)}` })
					: Response.json({ error: "pairing-key-invalid" }, { status: 403 });
			}
			if (path === "/api/connector/connections") return Response.json({ token: "connection" });
			if (path !== "/connector/mcp") return new Response(null, { status: 404 });
			let server = new Server({ name: "fake-chopin", version: "1" }, {
				capabilities: { tools: {} },
			});
			server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
			server.setRequestHandler(CallToolRequestSchema, async call => {
				tools.push(call.params.name);
				if (call.params.name === "wait_for_work") await Bun.sleep(2000);
				return { content: [{ type: "text", text: "{}" }] };
			});
			let transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await server.connect(transport);
			return transport.handleRequest(request);
		},
	});
	let url = `http://127.0.0.1:${chopin.port}`;
	let home = await realpath(await mkdtemp(join(scratch, "home-")));
	let directory = join(home, "state");
	await mkdir(directory, { recursive: true });
	if (paired) {
		await writeFile(
			join(directory, "machine.json"),
			JSON.stringify({ servers: { [url]: { token: `chopin_m_${"M".repeat(43)}`, label: "box" } } }),
		);
	}
	let bin = join(home, "bin");
	await mkdir(bin);
	// An agent that answers ACP initialize, as install's check needs.
	let fake = join(import.meta.dir, "testing", "fake-agent.ts");
	await writeFile(join(bin, "agent"), `#!/bin/sh\nexec ${process.execPath} ${fake}\n`, {
		mode: 0o755,
	});
	let root = join(home, "checkout");
	await mkdir(root);
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git(root, "add", ".");
	git(root, "commit", "-m", "fixture");
	let calls: string[] = [];
	let host: ServiceHost = {
		platform: "linux",
		home,
		user: "ada",
		uid: 501,
		env: { PATH: `${bin}:/usr/bin:/bin` },
		async run(command, args) {
			let line = [command, ...args].join(" ");
			calls.push(line);
			return { code: 0, stdout: "", stderr: "", ...answer(line) };
		},
		sleep: async () => {},
	};
	let saved = {
		CHOPIN_HOME: process.env.CHOPIN_HOME,
		CHOPIN_URL: process.env.CHOPIN_URL,
		PATH: process.env.PATH,
	};
	process.env.CHOPIN_HOME = directory;
	process.env.CHOPIN_URL = url;
	// This shell finds the agent too, as connect checks before it pairs.
	process.env.PATH = `${bin}:${process.env.PATH}`;
	return {
		calls,
		tools,
		requests,
		home,
		directory,
		bin,
		run: (...flags: string[]) =>
			connect([root, "--install-service", ...flags, "--", "agent", "--acp"], {
				host,
				executable: "/opt/chopin/bin/chopin",
			}),
		/** As `run`, with `agent` as the ACP command instead. */
		runAgent: (...agent: string[]) =>
			connect([root, "--install-service", "--", ...agent], {
				host,
				executable: "/opt/chopin/bin/chopin",
			}),
		async [Symbol.asyncDispose]() {
			for (let [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			delete process.env.CHOPIN_PAIRING_KEY;
			await chopin.stop(true);
		},
	};
}

function systemd(line: string): Partial<Outcome> | undefined {
	if (line.startsWith("loginctl show-user")) return { stdout: "yes\n" };
	if (line.startsWith("systemctl --user is-active")) return { code: 3, stdout: "inactive\n" };
	return undefined;
}

test.skipIf(process.platform === "win32")(
	"connect --install-service connects, saves, disconnects, then installs the service",
	async () => {
		await using machine = await setup(systemd);
		await machine.run();
		expect(machine.tools).toContain("wait_for_work");
		expect(machine.tools.at(-1)).toBe("disconnect_workspace");
		expect(machine.calls).toContain("systemctl --user enable --now chopin.service");
		let config = await readConfig(machine.directory);
		expect(config.service?.settings?.command).toEqual([join(machine.bin, "agent"), "--acp"]);
		expect(config.service?.executable).toBe("/opt/chopin/bin/chopin");
		// Its own connection let go of the checkout before the service took it.
		expect((await readdir(machine.directory)).filter(name => name.endsWith(".lock"))).toEqual([]);
	},
	20_000,
);

test.skipIf(process.platform === "win32")(
	"connect --install-service pairs with a key from the environment and writes it nowhere",
	async () => {
		await using machine = await setup(systemd, { paired: false });
		process.env.CHOPIN_PAIRING_KEY = PAIRING_KEY;
		await machine.run();
		expect(machine.calls).toContain("systemctl --user enable --now chopin.service");
		// Neither the agent the service starts nor anything after inherits it.
		expect(process.env.CHOPIN_PAIRING_KEY).toBeUndefined();
		let written = await Array.fromAsync(
			new Bun.Glob("**/*").scan({ cwd: machine.home, dot: true, onlyFiles: true }),
		);
		// The service definition, config.json, machine.json and the log are all under this home.
		expect(written).toContain(".config/systemd/user/chopin.service");
		for (let file of written) {
			let text = await Bun.file(join(machine.home, file)).text();
			expect(text, file).not.toContain(PAIRING_KEY);
		}
		expect(machine.calls.join("\n")).not.toContain(PAIRING_KEY);
	},
	20_000,
);

test.skipIf(process.platform === "win32")(
	"connect --install-service ends with install's refusals, and keeps what connect saved",
	async () => {
		await using machine = await setup(line =>
			line.startsWith("systemctl --user show")
				? { code: 1, stderr: "Failed to connect to bus" }
				: systemd(line)
		);
		// An agent that can't start headless: the check refuses it, and --skip-check goes past it.
		await writeFile(join(machine.bin, "agent"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
		let checked = await machine.run().catch(error => error);
		expect(checked.message).toContain("agent didn't answer ACP initialize");
		expect(checked.message).toContain("(exit 127)");
		expect(checked.message).toContain("--skip-check");
		let error = await machine.run("--skip-check").catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("can't reach your systemd user manager");
		expect(error.message).toContain("Nothing was installed.");
		let config = await readConfig(machine.directory);
		expect(config.connect?.command).toEqual(["agent", "--acp"]);
		expect(config.service).toBeUndefined();
	},
	20_000,
);

test.skipIf(process.platform === "win32")(
	"connect --install-service checks the agent starts before it spends a pairing key",
	async () => {
		await using machine = await setup(systemd, { paired: false });
		// Signed out or broken: it never answers ACP initialize.
		await writeFile(join(machine.bin, "agent"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		process.env.CHOPIN_PAIRING_KEY = PAIRING_KEY;
		let refused = await machine.run().catch(error => error);
		expect(refused.message).toContain("agent didn't answer ACP initialize (exit 3)");
		expect(refused.message).toContain("so nothing was paired");
		expect(machine.requests).toEqual([]);
		expect(machine.calls).toEqual([]);
		// Fixed, the same key pairs.
		await writeFile(
			join(machine.bin, "agent"),
			`#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "testing", "fake-agent.ts")}\n`,
			{ mode: 0o755 },
		);
		process.env.CHOPIN_PAIRING_KEY = PAIRING_KEY;
		await machine.run();
		expect(machine.requests[0]).toBe("/api/connector/pairings");
		expect(machine.calls).toContain("systemctl --user enable --now chopin.service");
	},
	30_000,
);

test.skipIf(process.platform === "win32")(
	"a known agent that won't start is named with its sign-in command, before the key is spent",
	async () => {
		await using machine = await setup(systemd, { paired: false });
		await writeFile(
			join(machine.bin, "copilot"),
			"#!/bin/sh\necho 'Error: not logged in' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		process.env.CHOPIN_PAIRING_KEY = PAIRING_KEY;
		let refused = await machine.runAgent("copilot", "--acp").catch(error => error);
		expect(refused.message).toContain(
			"copilot didn't answer ACP initialize (exit 1: Error: not logged in)",
		);
		expect(refused.message).toContain("sign in with `copilot login`, then run this command again");
		expect(machine.requests).toEqual([]);
	},
	30_000,
);
