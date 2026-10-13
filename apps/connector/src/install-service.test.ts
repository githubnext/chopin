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

async function setup(answer: (line: string) => Partial<Outcome> | undefined) {
	let tools: string[] = [];
	let chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let path = new URL(request.url).pathname;
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
	await writeFile(
		join(directory, "machine.json"),
		JSON.stringify({ servers: { [url]: { token: `chopin_m_${"M".repeat(43)}`, label: "box" } } }),
	);
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
	let saved = { CHOPIN_HOME: process.env.CHOPIN_HOME, CHOPIN_URL: process.env.CHOPIN_URL };
	process.env.CHOPIN_HOME = directory;
	process.env.CHOPIN_URL = url;
	return {
		calls,
		tools,
		directory,
		bin,
		run: (...flags: string[]) =>
			connect([root, "--install-service", ...flags, "--", "agent", "--acp"], {
				host,
				executable: "/opt/chopin/bin/chopin",
			}),
		async [Symbol.asyncDispose]() {
			for (let [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
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
