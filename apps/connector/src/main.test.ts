import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_UPDATE_REQUIRED,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
import { git } from "./workspace";

let scratch = await mkdtemp(join(tmpdir(), "chopin-main-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/** Programs the connects below name as their agent and Planner; they are found, never run. */
let programs = join(scratch, "programs");
await mkdir(programs);
for (let name of ["agent", "new-agent", "planner", "a"]) {
	let file = process.platform === "win32" ? `${name}.cmd` : name;
	await writeFile(join(programs, file), "#!/bin/sh\n", { mode: 0o755 });
}

async function checkout() {
	let root = await mkdtemp(join(scratch, "checkout-"));
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git(root, "add", ".");
	git(root, "commit", "-m", "fixture");
	return root;
}

const MESSAGE = "chopin 0.0.1 speaks connector protocol 0, but this server needs protocol 1. "
	+ "Run `chopin update 0.1.3`, then connect again.";

/**
 * `connect` against a fake Chopin that refuses the connector's version at `refuse`: the pairing
 * request or the first connector call. With `refuse` "nothing" it connects, and the connector
 * gets a Ctrl-C at its first wait for work. Records each request with the version headers it
 * carried.
 */
async function connect(
	refuse: "pairing" | "connector" | "nothing",
	args?: string[],
	state?: string,
	extra: Record<string, string> = {},
) {
	let requests: Array<[string, string | null, string | null]> = [];
	let chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let path = new URL(request.url).pathname;
			requests.push([
				path,
				request.headers.get(CONNECTOR_VERSION_HEADER),
				request.headers.get(CONNECTOR_PROTOCOL_HEADER),
			]);
			if (
				refuse === "pairing" && path === "/api/connector/pairings"
				|| refuse === "connector" && path === "/connector/mcp"
			) {
				return Response.json({ error: CONNECTOR_UPDATE_REQUIRED, message: MESSAGE }, {
					status: 409,
				});
			}
			if (path === "/api/connector/pairings") {
				return Response.json({ id: "pairing", secret: "secret", url: "http://x", code: "AB" });
			}
			if (path === "/api/connector/pairings/pairing/claim") {
				return Response.json({ token: `chopin_m_${"M".repeat(43)}` });
			}
			if (path === "/api/connector/connections") {
				return Response.json({ token: "connection-token" });
			}
			if (path === "/connector/mcp") {
				let server = new Server({ name: "fake-chopin", version: "1" }, {
					capabilities: { tools: {} },
				});
				server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
				server.setRequestHandler(CallToolRequestSchema, async request => {
					if (request.params.name === "wait_for_work") connector.kill("SIGINT");
					return { content: [{ type: "text", text: "{}" }] };
				});
				let transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await server.connect(transport);
				return transport.handleRequest(request);
			}
			return new Response(null, { status: 404 });
		},
	});
	let directory = state ?? await mkdtemp(join(scratch, "state-"));
	let url = `http://127.0.0.1:${chopin.port}`;
	let connector = Bun.spawn([
		process.execPath,
		"--no-env-file",
		join(import.meta.dir, "main.ts"),
		"connect",
		...args ?? [await checkout(), "--", "agent"],
	], {
		env: {
			...process.env,
			CHOPIN_URL: url,
			CHOPIN_CONNECTOR_STATE_DIR: directory,
			...extra,
			PATH: [extra.PATH ?? process.env.PATH, programs].join(delimiter),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		let code = await Promise.race([connector.exited, Bun.sleep(20_000).then(() => "timed out")]);
		return {
			code,
			stdout: await new Response(connector.stdout).text(),
			stderr: await new Response(connector.stderr).text(),
			requests,
			directory,
			url,
		};
	} finally {
		connector.kill("SIGKILL");
		await chopin.stop(true);
	}
}

test("connect sends its version and protocol, and stops on a refusal at pairing", async () => {
	let result = await connect("pairing");
	expect(result.code).toBe(1);
	expect(result.stderr).toBe(`${MESSAGE}\n`);
	expect(result.requests).toEqual([
		["/api/connector/pairings", VERSION, String(CONNECTOR_PROTOCOL)],
	]);
	// A connect that never connected saves nothing for service install.
	expect(await Bun.file(join(result.directory, "config.json")).exists()).toBe(false);
});

test("connect stops without retrying when the connector endpoint refuses its version", async () => {
	let result = await connect("connector");
	expect(result.code).toBe(1);
	expect(result.stderr).toBe(`${MESSAGE}\n`);
	let headers = [VERSION, String(CONNECTOR_PROTOCOL)] as const;
	expect(result.requests).toEqual([
		["/api/connector/pairings", ...headers],
		["/api/connector/pairings/pairing/claim", ...headers],
		["/api/connector/connections", ...headers],
		["/connector/mcp", ...headers],
	]);
	expect(await Bun.file(join(result.directory, "config.json")).exists()).toBe(false);
});

test("connect saves the server, checkout, agent, Planner and --env it ran once it has connected", async () => {
	let root = await checkout();
	let planner = ["--planner", "https://chopin.example/d/one", "--planner-command", "planner --x"];
	let env = ["--env", "SOME_FLAG=1", "--env=LABEL=two words="];
	let started = await connect("nothing", [root, ...planner, ...env, "--", "agent", "--acp"]);
	expect(started.stdout).toContain("✓ Connected.");
	expect(started.code).toBe(0);
	let file = join(started.directory, "config.json");
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
		connect: {
			server: started.url,
			checkout: await realpath(root),
			command: ["agent", "--acp"],
			planners: ["https://chopin.example/d/one"],
			plannerCommand: ["planner", "--x"],
			env: { SOME_FLAG: "1", LABEL: "two words=" },
		},
	});
	expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("connect refuses an --env it can't pass on, before it pairs", async () => {
	let root = await checkout();
	for (let bad of ["CHOPIN_URL=https://x", "PATH=/opt/bin", "1FLAG=x", "FLAG", "A-B=1"]) {
		let refused = await connect("pairing", [root, "--env", bad, "--", "agent"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--env");
		expect(refused.requests).toEqual([]);
	}
});

test.skipIf(process.platform === "win32")(
	"connect saves the stable path behind a shell's fnm directory, and warns when there is none",
	async () => {
		let root = await checkout();
		let home = await realpath(await mkdtemp(join(scratch, "home-")));
		let run = join(home, "run");
		let installation = join(home, "fnm", "node-versions", "v24", "installation");
		let stable = join(installation, "bin");
		let shell = join(run, "fnm_multishells", "4242_1700000000000");
		await mkdir(stable, { recursive: true });
		await mkdir(join(run, "fnm_multishells"), { recursive: true });
		await symlink(installation, shell);
		for (let name of ["my-agent", "my-planner"]) {
			await writeFile(join(stable, name), "#!/bin/sh\n", { mode: 0o755 });
		}
		let env = { XDG_RUNTIME_DIR: run, PATH: `${join(shell, "bin")}:${process.env.PATH}` };
		let planner = [
			"--planner",
			"https://chopin.example/d/one",
			"--planner-command",
			"my-planner x",
		];
		let started = await connect(
			"nothing",
			[root, ...planner, "--", "env", "SOME_FLAG=1", "my-agent", "--acp"],
			undefined,
			env,
		);
		expect(started.code).toBe(0);
		let saved = JSON.parse(await readFile(join(started.directory, "config.json"), "utf8"));
		expect(saved.connect.command).toEqual([
			"env",
			"SOME_FLAG=1",
			join(stable, "my-agent"),
			"--acp",
		]);
		expect(saved.connect.plannerCommand).toEqual([join(stable, "my-planner"), "x"]);
		expect(started.stdout).toContain(
			`Saved my-agent as ${join(stable, "my-agent")}, since ${join(shell, "bin", "my-agent")} `
				+ "lasts only as long as this shell.",
		);
		expect(started.stdout).toContain(`Saved my-planner as ${join(stable, "my-planner")}`);

		// A program that lives only in a per-shell directory is saved as given, with a warning.
		let only = join(run, "fnm_multishells", "9_9", "bin");
		await mkdir(only, { recursive: true });
		await writeFile(join(only, "shell-agent"), "#!/bin/sh\n", { mode: 0o755 });
		let warned = await connect("nothing", [root, "--", "shell-agent"], undefined, {
			XDG_RUNTIME_DIR: run,
			PATH: `${only}:${process.env.PATH}`,
		});
		expect(warned.code).toBe(0);
		expect(
			JSON.parse(await readFile(join(warned.directory, "config.json"), "utf8")).connect.command,
		)
			.toEqual(["shell-agent"]);
		expect(warned.stderr).toContain(
			`shell-agent is ${join(only, "shell-agent")}, which lasts only as long as this shell, so `
				+ "chopin service install will refuse it.",
		);
	},
);

/** The settings `chopin service install` copied for a service that runs `checkout` on `server`. */
function installed(directory: string, server: string, checkout: string) {
	let settings = { server, checkout, command: ["old-agent"], planners: [], plannerCommand: [] };
	let service = {
		executable: "/opt/chopin",
		directory,
		version: VERSION,
		installedAt: 1,
		settings,
	};
	return writeFile(join(directory, "config.json"), JSON.stringify({ service }));
}

function lockPath(directory: string, root: string) {
	return join(directory, `${new Bun.CryptoHasher("sha256").update(root).digest("hex")}.lock`);
}

test("connect in another checkout leaves what the running service runs alone", async () => {
	let serviceRoot = await realpath(await checkout());
	let directory = await mkdtemp(join(scratch, "state-"));
	await installed(directory, "https://service.example", serviceRoot);
	let before = JSON.parse(await readFile(join(directory, "config.json"), "utf8")).service;
	let lock = lockPath(directory, serviceRoot);
	await writeFile(lock, JSON.stringify({ pid: process.pid, root: serviceRoot, service: true }));

	let other = await realpath(await checkout());
	let started = await connect("nothing", [other, "--", "agent"], directory);
	expect(started.code).toBe(0);
	let config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
	expect(config.connect).toMatchObject({ server: started.url, checkout: other });
	expect(config.service).toEqual(before);

	// The service, started again, runs its own settings: the server it was installed with.
	await rm(lock);
	let service = await connect("pairing", ["--service"], directory);
	expect(service.stderr).toContain("This machine is not paired with https://service.example.");
	expect(service.requests).toEqual([]);
});

test("connect --service stops until service install has saved what it runs", async () => {
	let directory = await mkdtemp(join(scratch, "state-"));
	let settings = { server: "https://x.example", checkout: scratch, command: ["agent"] };
	await writeFile(
		join(directory, "config.json"),
		JSON.stringify({ connect: { ...settings, planners: [], plannerCommand: [] } }),
	);
	let result = await connect("pairing", ["--service"], directory);
	expect(result.code).toBe(1);
	expect(result.stderr).toBe(
		"Run chopin connect once in your checkout first, then chopin service install.\n",
	);
	expect(result.requests).toEqual([]);
	let planner = ["--planner", "https://chopin.example/d/one", "--planner-command", "planner"];
	for (
		let args of [["--service", scratch], ["--service", "--", "agent"], ["--service", ...planner]]
	) {
		let refused = await connect("pairing", args, directory);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("connect --service takes no other arguments");
	}
});

test("connect on a checkout the running service holds saves it as the last connect only", async () => {
	let root = await realpath(await checkout());
	let directory = await mkdtemp(join(scratch, "state-"));
	let lock = (service: boolean) =>
		writeFile(
			lockPath(directory, root),
			JSON.stringify({ pid: process.pid, root, ...(service ? { service } : {}) }),
		);
	// A terminal's connect holds it: refused as before, and nothing is saved.
	await lock(false);
	let refused = await connect("pairing", [root, "--", "agent"], directory);
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain("Workspace already locked");
	expect(await Bun.file(join(directory, "config.json")).exists()).toBe(false);

	await installed(directory, "https://service.example", root);
	let before = JSON.parse(await readFile(join(directory, "config.json"), "utf8")).service;
	await lock(true);
	let saved = await connect("pairing", [root, "--", "new-agent", "--acp"], directory);
	expect(saved.code).toBe(0);
	expect(saved.stdout).toBe(
		"The chopin service is running this checkout. Saved your settings; run chopin service "
			+ "install to use them.\n",
	);
	expect(saved.requests).toEqual([]);
	let config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
	expect(config.connect).toEqual({
		server: saved.url,
		checkout: root,
		command: ["new-agent", "--acp"],
		planners: [],
		plannerCommand: [],
	});
	expect(config.service).toEqual(before);
	// Arguments connect refuses are never saved.
	let invalid = await connect(
		"pairing",
		[root, "--planner", "https://x/d/1", "--", "a"],
		directory,
	);
	expect(invalid.code).toBe(1);
	expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).connect.command)
		.toEqual(["new-agent", "--acp"]);
});

test.skipIf(process.platform === "win32")(
	"connect stops before it pairs when the agent or Planner isn't installed, saying how to get it",
	async () => {
		let root = await checkout();
		// A PATH with git and nothing else, so no coding agent installed here is found.
		let tools = join(scratch, "tools");
		await mkdir(tools, { recursive: true });
		await symlink(Bun.which("git")!, join(tools, "git")).catch(() => {});
		let only = { PATH: tools };
		let copilot = await connect(
			"nothing",
			[root, "--", "copilot", "--acp", "--allow-all"],
			undefined,
			only,
		);
		expect(copilot.code).toBe(1);
		expect(copilot.stderr).toBe(
			[
				"copilot isn't installed, so nothing was paired or connected. Install GitHub Copilot CLI "
				+ "and sign in to it:",
				"  npm install -g @github/copilot",
				"  copilot login",
				"Then run this command again.",
				"",
			].join("\n"),
		);
		expect(copilot.requests).toEqual([]);

		// Behind env, the program env starts is the one looked for.
		let codex = await connect(
			"nothing",
			[root, "--", "env", "INITIAL_AGENT_MODE=agent-full-access", "codex-acp"],
			undefined,
			{ PATH: [tools, dirname(Bun.which("env")!)].join(delimiter) },
		);
		expect(codex.code).toBe(1);
		expect(codex.stderr).toContain("codex-acp isn't installed");
		expect(codex.stderr).toContain(
			"  npm install -g @openai/codex @agentclientprotocol/codex-acp\n",
		);
		expect(codex.requests).toEqual([]);

		let unknown = await connect("nothing", [root, "--", "my-agent"], undefined, only);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toBe(
			"my-agent isn't on your PATH, so nothing was paired or connected. Install it or give its "
				+ "full path, then run this command again.\n",
		);
		expect(unknown.requests).toEqual([]);

		let planner = await connect(
			"nothing",
			[root, "--planner", "https://x/d/1", "--planner-command", "my-planner --x", "--", "agent"],
			undefined,
			only,
		);
		expect(planner.code).toBe(1);
		expect(planner.stderr).toContain("my-planner isn't on your PATH");
		expect(planner.requests).toEqual([]);
	},
	60_000,
);
