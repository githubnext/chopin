import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { privateAgentState } from "./ai-agent";
import { clonePath } from "./checkouts";
import { readConfig } from "./config";
import { builtInRecipe, INSTALL_FROM } from "./images";
import { artifactsAt, UNSUPPORTED_LEAD } from "./nvx";
import { AgentStore } from "./machine-store";
import { machineRecipes, openMachineSandbox } from "./machine-sandbox";
import { createOutput } from "./output";
import { plannerEnvironment, servePlanners } from "./planner";
import { plannerSpares } from "./planner-spare";
import {
	createSandbox,
	type Launch,
	type Sandbox,
	startNvx,
	type StartOptions,
	type Unsupported,
} from "./sandbox";
import { answerTokens } from "./testing/github-grant";
import type { SpareState } from "./workspace";

/**
 * Real microVMs, on this machine's KVM: what a guest can reach, write and keep. They run where
 * CHOPIN_NVX_ROOT names an extracted NVX package and this user can use /dev/kvm, and skip, saying
 * so, elsewhere (CI runners without KVM). The image is built once into CHOPIN_NVX_TEST_BASE where
 * that is set, else into a temporary state directory, which takes a minute.
 */
function kvm() {
	try {
		accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
let artifacts = process.env.CHOPIN_NVX_ROOT
	? artifactsAt(process.env.CHOPIN_NVX_ROOT, "linux")
	: undefined;
let usable = process.platform === "linux" && kvm() && !!artifacts;
if (!usable) {
	// CI's microVM job sets CHOPIN_NVX_REQUIRED, so a runner that lost KVM fails rather than skips.
	if (process.env.CHOPIN_NVX_REQUIRED) {
		throw new Error(
			"The microVM tests need CHOPIN_NVX_ROOT and /dev/kvm, which this machine lacks.",
		);
	}
	console.warn("Skipping the microVM tests: set CHOPIN_NVX_ROOT and give this user /dev/kvm.");
}

// The microVMs' failures to start are made with strace, as OpenVMM's under heavy load: io_uring
// can't be set up, and its disk can't be either.
let strace = Bun.which("strace");
if (usable && !strace && process.env.CHOPIN_NVX_REQUIRED) {
	throw new Error("The microVM tests need strace to make a start fail.");
}

let scratch = mkdtempSync(join(tmpdir(), "chopin-nvx-vm-"));
let base = process.env.CHOPIN_NVX_TEST_BASE ?? join(scratch, "state");
let sandbox: Sandbox;
let chopin: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let repository = join(scratch, "repo");
/** How many of the next starts of a microVM fail as OpenVMM's did under heavy load. */
let failing = 0;
let retried: string[] = [];
/** Whether the next start's OpenVMM may not open /dev/kvm, as when logind took back the access. */
let denying = false;
let unsupported: Unsupported[] = [];

/**
 * `nvx`, or `nvx` under strace with io_uring refused, as OpenVMM is refused it under heavy load, or
 * with /dev/kvm refused, as when this user's access to it was taken back.
 */
function start(program: string, words: string[], launch: StartOptions) {
	if (denying && strace) {
		denying = false;
		return startNvx(
			strace,
			[
				"-f",
				"-qq",
				"-o",
				"/dev/null",
				"-P",
				"/dev/kvm",
				"-e",
				"inject=openat:error=EACCES",
				program,
				...words,
			],
			launch,
		);
	}
	if (failing <= 0 || !strace) return startNvx(program, words, launch);
	failing--;
	return startNvx(
		strace,
		["-f", "-qq", "-o", "/dev/null", "-e", "inject=io_uring_setup:error=ENOMEM", program, ...words],
		launch,
	);
}

function git(cwd: string, ...args: string[]) {
	let result = spawnSync("git", [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"-c",
		"commit.gpgsign=false",
		...args,
	], {
		cwd,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** Runs `launch` to its end; its stdout and stderr, and how it exited. */
function run(launch: Launch): Promise<{ code: number | null; out: string; err: string }> {
	let child = sandbox.spawn(launch);
	let out = "";
	let err = "";
	child.stdout.on("data", chunk => out += chunk);
	child.stderr.on("data", chunk => err += chunk);
	return new Promise(resolve => child.once("close", code => resolve({ code, out, err })));
}

beforeAll(async () => {
	if (!usable) return;
	mkdirSync(base, { recursive: true, mode: 0o700 });
	mkdirSync(repository);
	git(repository, "init", "-q", "-b", "main");
	writeFileSync(join(repository, "README.md"), "the repository\n");
	git(repository, "add", ".");
	git(repository, "commit", "-qm", "initial");
	writeFileSync(join(repository, "notes.txt"), "not committed\n");
	chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/connector/mcp") return new Response("chopin\n");
			if (request.headers.get("authorization") !== "Bearer chopin_r_run") {
				return new Response(null, { status: 401 });
			}
			let server = new Server({ name: "fake-chopin", version: "1" }, {
				capabilities: { tools: {} },
			});
			server.setRequestHandler(ListToolsRequestSchema, () => ({
				tools: ["read_investigation", "upload_investigation_image"].map(name => ({
					name,
					inputSchema: { type: "object" as const },
				})),
			}));
			let transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await server.connect(transport);
			return transport.handleRequest(request);
		},
	});
	other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other\n") });
	let recipe = builtInRecipe("copilot")!;
	// What an install reads from the host (--install-from), in a folder only its owner may read.
	let inputs = join(scratch, "inputs");
	mkdirSync(inputs, { mode: 0o700 });
	writeFileSync(join(inputs, "tool"), "#!/bin/sh\necho installed from the host folder\n", {
		mode: 0o700,
	});
	sandbox = await createSandbox({
		directory: base,
		server: `http://127.0.0.1:${chopin.port}`,
		setup: { artifacts: artifacts!, hypervisor: "kvm" },
		recipes: new Map([
			["bash", { ...recipe, programs: ["bash"] }],
			[
				"from-tool",
				{
					name: "from-tool",
					install: [`cp ${INSTALL_FROM}/tool "$npm_config_prefix/bin/from-tool"`],
					programs: ["from-tool"],
					from: inputs,
				},
			],
		]),
		start,
		retrying: detail => retried.push(detail),
		unsupported: problem => unsupported.push(problem),
	});
}, 600_000);

afterAll(async () => {
	await sandbox?.close();
	chopin?.stop(true);
	other?.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!usable)("an agent in its microVM", () => {
	test(
		"works in a clone of its own, reads the person's git directory and never writes it",
		async () => {
			let tokens = join(base, "runs", "vm-run.tokens");
			mkdirSync(tokens, { recursive: true });
			let commit = git(repository, "rev-parse", "HEAD");
			let { code, out, err } = await run({
				command: [
					"bash",
					"-c",
					[
						"pwd",
						"git branch --show-current",
						"echo change > changed.txt && git add changed.txt && git -c user.name=a -c user.email=a@a commit -qm work && git rev-list --count HEAD",
						`(echo planted > ${repository}/.git/hooks/post-commit) 2>&1 | grep -o 'Read-only file system'`,
					].join("; "),
				],
				cwd: "/work/repo",
				env: {},
				stdin: "ignore",
				own: [tokens],
				repository: {
					source: join(repository, ".git"),
					path: "/work/repo",
					commit,
					branch: "chopin/implement-vm",
					origin: "https://github.com/octo-org/repo.git",
				},
			});
			expect({ code, err: err.replace(/^>>.*\n/gm, "") }).toEqual({ code: 0, err: "" });
			expect(out.trim().split("\n")).toEqual([
				"/work/repo",
				"chopin/implement-vm",
				"2",
				"Read-only file system",
			]);
			// Nothing of the guest's commit or files reached the person's repository.
			expect(git(repository, "rev-list", "--count", "--all")).toBe("1");
			expect(readdirSync(join(repository, ".git", "hooks")).includes("post-commit")).toBe(false);
		},
		120_000,
	);

	test(
		"a Planner reads the person's uncommitted files and keeps its repository on its disk between starts",
		async () => {
			let folder = join(base, "planners", "octo-org", "repo", "doc-vm");
			mkdirSync(`${folder}.tokens`, { recursive: true });
			await sandbox.makeDisk!(`${folder}.disk`);
			let planner = (script: string): Launch => ({
				command: ["bash", "-c", script],
				cwd: "/work/repo",
				env: {},
				stdin: "ignore",
				own: [`${folder}.tokens`],
				reads: [repository],
				repository: { source: join(repository, ".git"), path: "/work/repo", dissociate: true },
				disk: `${folder}.disk`,
			});
			let first = await run(
				planner(`cat ${repository}/notes.txt; cat README.md; echo kept > state.txt`),
			);
			expect(first.code).toBe(0);
			expect(first.out).toBe("not committed\nthe repository\n");
			let second = await run(
				planner("cat state.txt; test ! -e .git/objects/info/alternates && echo own-objects"),
			);
			expect(second.out).toBe("kept\nown-objects\n");
		},
		180_000,
	);

	test(
		"a Planner's new disk takes on the host only what its guest writes, not ext4's tables",
		async () => {
			let folder = join(base, "planners", "octo-org", "repo", "doc-sparse");
			mkdirSync(`${folder}.tokens`, { recursive: true });
			await sandbox.makeDisk!(`${folder}.disk`);
			// ext4 zeroes its inode tables a while after a first mount unless it was told they are.
			let { code } = await run({
				command: ["bash", "-c", "sleep 40"],
				cwd: "/work/repo",
				env: {},
				stdin: "ignore",
				own: [`${folder}.tokens`],
				reads: [repository],
				repository: { source: join(repository, ".git"), path: "/work/repo", dissociate: true },
				disk: `${folder}.disk`,
			});
			expect(code).toBe(0);
			// Allocated, in MiB: the clone of a one-commit repository and ext4's own few, not 512.
			expect(statSync(`${folder}.disk`).blocks * 512 / 1024 ** 2).toBeLessThan(64);
		},
		180_000,
	);

	test(
		"a link a Planner's guest leaves in its agent state is never followed at its next start",
		async () => {
			let slot = join(base, "planners", "octo-org", "repo", "doc-links");
			let home = `${slot}.agent`;
			mkdirSync(home, { recursive: true });
			let victim = join(scratch, "victim");
			mkdirSync(victim);
			let { code } = await run({
				command: ["bash", "-c", `rm -rf ${home}/atomic; ln -s ${victim} ${home}/atomic`],
				cwd: home,
				env: {},
				stdin: "ignore",
				own: [home],
				agentHome: home,
			});
			expect(code).toBe(0);
			let store = new AgentStore(
				{ url: "postgresql://m_1@db.example.com:5432/m_1", password: "the-database-password" },
				join(scratch, "adapter"),
			);
			mkdirSync(join(scratch, "adapter"), { recursive: true });
			plannerEnvironment(true, slot, {}, store);
			expect(readdirSync(victim)).toEqual([]);
			expect(readFileSync(join(home, "atomic", "storage-password"), "utf8")).toBe(
				"the-database-password",
			);
		},
		120_000,
	);

	test(
		"a launch whose base dir is reached through a link writes its agent state where the host has it",
		async () => {
			// As on a machine whose ~/.local is a link to another disk: the launch names its paths
			// through the link, and its guest has only where they really are.
			let linked = join(scratch, "linked-state");
			symlinkSync(base, linked);
			let home = join(linked, "runs", "vm-linked.agent");
			let tokens = join(linked, "runs", "vm-linked.tokens");
			mkdirSync(tokens, { recursive: true });
			let { code, err } = await run({
				command: [
					"bash",
					"-c",
					'mkdir -p "$ATOMIC_CODING_AGENT_DIR/sessions" && echo kept > "$ATOMIC_CODING_AGENT_DIR/sessions/one" && echo copilot > "$COPILOT_HOME/state"',
				],
				cwd: home,
				env: privateAgentState(home),
				stdin: "ignore",
				own: [tokens, home],
				agentHome: home,
			});
			expect({ code, err: err.replace(/^>>.*\n/gm, "") }).toEqual({ code: 0, err: "" });
			let real = join(realpathSync(base), "runs", "vm-linked.agent");
			expect(readFileSync(join(real, "atomic", "sessions", "one"), "utf8")).toBe("kept\n");
			expect(readFileSync(join(real, "copilot", "state"), "utf8")).toBe("copilot\n");
		},
		120_000,
	);

	test(
		"a command named by a host path that is gone runs its image's program by its name",
		async () => {
			// As the agent `chopin connect` found installed on the host, and saved by its path, once it
			// was removed from the host.
			let gone = join(scratch, "uninstalled", "bin", "bash");
			mkdirSync(join(scratch, "uninstalled", "bin"), { recursive: true });
			writeFileSync(gone, "#!/bin/sh\necho the host's\n", { mode: 0o755 });
			rmSync(join(scratch, "uninstalled"), { recursive: true, force: true });
			let tokens = join(base, "runs", "vm-gone.tokens");
			mkdirSync(tokens, { recursive: true });
			let { code, out } = await run({
				command: [gone, "-c", "echo ran in the image"],
				cwd: tokens,
				env: {},
				stdin: "ignore",
				own: [tokens],
			});
			expect({ code, out }).toEqual({ code: 0, out: "ran in the image\n" });
		},
		120_000,
	);

	test(
		"an image's install reads its folder from the host, which no agent's guest has",
		async () => {
			let cwd = mkdtempSync(join(scratch, "cwd-"));
			let installed = await run({
				command: ["from-tool"],
				cwd,
				env: {},
				stdin: "ignore",
			});
			expect(installed).toMatchObject({ code: 0, out: "installed from the host folder\n" });
			let agent = await run({
				command: ["bash", "-c", `test -e ${INSTALL_FROM} && echo there || echo absent`],
				cwd,
				env: {},
				stdin: "ignore",
			});
			expect(agent.out).toBe("absent\n");
		},
		60_000,
	);

	test("reaches Chopin through the proxy and nothing else", async () => {
		let tokens = join(base, "runs", "vm-net.tokens");
		mkdirSync(tokens, { recursive: true });
		let get = (port: number | undefined, fd: number) =>
			`exec ${fd}<>/dev/tcp/10.0.0.1/$P; printf 'GET http://127.0.0.1:${port}/ HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n' >&${fd}; timeout 5 tail -1 <&${fd}`;
		let { code, out } = await run({
			command: [
				"bash",
				"-c",
				[
					'P="${HTTP_PROXY##*:}"',
					`timeout 3 bash -c 'exec 3<>/dev/tcp/10.0.0.1/${chopin.port}' 2>/dev/null && echo direct || echo no-direct`,
					get(chopin.port, 4),
					get(other.port, 5),
					"echo; getent hosts github.com >/dev/null && echo dns || echo no-dns",
				].join("; "),
			],
			cwd: tokens,
			env: {},
			stdin: "ignore",
			own: [tokens],
		});
		expect(code).toBe(0);
		expect(out).toContain("no-direct");
		expect(out).toContain("chopin\n");
		expect(out).not.toContain("other\n");
		expect(out).toContain("no-dns");
	}, 120_000);

	test(
		"a run's MCP bridge runs on its image's Node and reaches Chopin's tools for the run through the proxy",
		async () => {
			let tokens = join(base, "runs", "vm-bridge.tokens");
			mkdirSync(tokens, { recursive: true });
			let lines = [
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "t", version: "1" },
					},
				},
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			].map(line => JSON.stringify(line)).join("\n");
			let bridge = sandbox.bridge;
			let { code, out } = await run({
				command: [
					"bash",
					"-c",
					`(printf '%s\\n' '${lines}'; sleep 8) | timeout 20 ${bridge.command} ${
						bridge.args.join(" ")
					}`,
				],
				cwd: tokens,
				env: {
					CHOPIN_BRIDGE_ORIGIN: `http://127.0.0.1:${chopin.port}`,
					CHOPIN_BRIDGE_TOKEN: "chopin_r_run",
				},
				stdin: "ignore",
				own: [tokens],
			});
			let listed = out.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(answer =>
				answer.id === 2
			);
			expect(listed?.result?.tools?.map((tool: { name: string }) => tool.name), out).toEqual([
				"read_investigation",
				"upload_investigation_image",
			]);
			expect(code === 0 || code === 124).toBe(true);
		},
		120_000,
	);

	test("a server the agent left running ends with its microVM", async () => {
		let tokens = join(base, "runs", "vm-orphan.tokens");
		// A duration no other process on the host sleeps for.
		let marker = `${600 + Math.floor(Math.random() * 1000)}.${process.pid}`;
		mkdirSync(tokens, { recursive: true });
		let { code } = await run({
			command: ["bash", "-c", `setsid sleep ${marker} >/dev/null 2>&1 < /dev/null & echo started`],
			cwd: tokens,
			env: {},
			stdin: "ignore",
			own: [tokens],
		});
		expect(code).toBe(0);
		// Nothing of the guest is left on the host: no sleep, no OpenVMM, no record.
		let left = spawnSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" }).stdout.trim();
		expect(left).toBe("");
		expect(readdirSync(join(base, "nvx", "launches"))).toEqual([]);
	}, 120_000);

	test(
		"ending a launch ends its microVM, OpenVMM included, and leaves nothing of nvx's",
		async () => {
			let tokens = join(base, "runs", "vm-end.tokens");
			mkdirSync(tokens, { recursive: true });
			let child = sandbox.spawn({
				command: ["bash", "-c", "echo up; sleep 600"],
				cwd: tokens,
				env: {},
				stdin: "ignore",
				own: [tokens],
			});
			let closed = new Promise(resolve => child.once("close", resolve));
			let up = await new Promise<string>(resolve =>
				child.stdout.once("data", chunk => resolve(String(chunk)))
			);
			// The guest's first words are the workload's own: nothing of nvx's or of the launcher's.
			expect(up).toBe("up\n");
			let launches = join(base, "nvx", "launches");
			let [name] = readdirSync(launches);
			let { run } = JSON.parse(readFileSync(join(launches, name!, "launch.json"), "utf8"));
			// nvx keeps a folder in the temporary directory, which it leaves when ended by force.
			expect(readdirSync(run)).toContain("openvmm.log");
			let group = child.pid!;
			let members = () =>
				spawnSync("ps", ["-o", "pid=", "-g", String(group)], { encoding: "utf8" }).stdout.trim();
			expect(members()).not.toBe("");
			let ended = Date.now();
			process.kill(-group, "SIGKILL");
			while (members() && Date.now() - ended < 5_000) await Bun.sleep(100);
			expect(members()).toBe("");
			await closed;
			expect(existsSync(run)).toBe(false);
			expect(readdirSync(launches)).toEqual([]);
		},
		120_000,
	);

	test.skipIf(!strace)(
		"a microVM OpenVMM couldn't start for io_uring starts again, and its workload runs once",
		async () => {
			let tokens = join(base, "runs", "vm-again.tokens");
			mkdirSync(tokens, { recursive: true });
			let runs = join(base, "runs", "vm-again.agent");
			retried = [];
			failing = 1;
			let child = sandbox.spawn({
				command: ["bash", "-c", `echo ran >> ${runs}/runs; read line; echo "read $line"`],
				cwd: runs,
				env: {},
				stdin: "pipe",
				own: [tokens, runs],
				agentHome: runs,
			});
			// Written before the microVM started: the workload that starts reads it, once.
			child.stdin!.end("hello\n");
			let out = "";
			let err = "";
			child.stdout.on("data", chunk => out += chunk);
			child.stderr.on("data", chunk => err += chunk);
			let code = await new Promise(resolve => child.once("close", resolve));
			expect({ code, out, err }).toEqual({ code: 0, out: "read hello\n", err: "" });
			expect(readFileSync(join(runs, "runs"), "utf8")).toBe("ran\n");
			expect(retried).toEqual([
				"A microVM didn't start (OpenVMM: driver does not support io-uring), so chopin starts it again (2 of 3).",
			]);
			expect(readdirSync(join(base, "nvx", "launches"))).toEqual([]);
		},
		120_000,
	);

	test.skipIf(!strace)(
		"a microVM that never starts says why with the end of OpenVMM's log",
		async () => {
			let tokens = join(base, "runs", "vm-never.tokens");
			mkdirSync(tokens, { recursive: true });
			failing = 3;
			let { code, out, err } = await run({
				command: ["bash", "-c", "echo ran"],
				cwd: tokens,
				env: {},
				stdin: "ignore",
				own: [tokens],
			});
			expect({ code, out }).toEqual({ code: 1, out: "" });
			expect(err).toStartWith(
				"The microVM didn't start after 3 tries: fatal error: failed to launch vm worker / ",
			);
			expect(err).toContain(
				"4: driver does not support io-uring (nvx: error[exited]: OpenVMM exited during startup: vmm-failure status 1)",
			);
			expect(failing).toBe(0);
		},
		120_000,
	);

	test.skipIf(!strace)(
		"a microVM whose user may not open /dev/kvm says this machine can't run microVMs, and tells the connector",
		async () => {
			let tokens = join(base, "runs", "vm-denied.tokens");
			mkdirSync(tokens, { recursive: true });
			unsupported = [];
			retried = [];
			denying = true;
			let { code, out, err } = await run({
				command: ["bash", "-c", "echo ran"],
				cwd: tokens,
				env: {},
				stdin: "ignore",
				own: [tokens],
			});
			expect({ code, out }).toEqual({ code: 1, out: "" });
			// The words depend on whether this user joined the kvm group since this login began.
			expect(err).toStartWith(UNSUPPORTED_LEAD);
			expect(err).toContain("/dev/kvm");
			expect(err).toContain("Fix: ");
			expect(err).toEndWith(
				"(OpenVMM: failed to open file `/dev/kvm`: Permission denied (os error 13))\n",
			);
			expect(unsupported).toHaveLength(1);
			expect(unsupported[0]!.reason).toContain("/dev/kvm");
			// Never started again: it isn't the load's failure.
			expect(retried).toEqual([]);
		},
		120_000,
	);

	test("the guest's environment comes from its file and never a command line", async () => {
		let tokens = join(base, "runs", "vm-env.tokens");
		mkdirSync(tokens, { recursive: true });
		let secret = `canary-${Math.random().toString(36).slice(2)}`;
		let child = sandbox.spawn({
			command: ["bash", "-c", "echo $CHOPIN_TEST_SECRET; sleep 2"],
			cwd: tokens,
			env: { CHOPIN_TEST_SECRET: secret },
			stdin: "ignore",
			own: [tokens],
		});
		let out = "";
		child.stdout.on("data", chunk => out += chunk);
		await Bun.sleep(1_000);
		let lines = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
		expect(lines).not.toContain(secret);
		await new Promise(resolve => child.once("close", resolve));
		expect(out.trim()).toBe(secret);
		expect(readFileSync("/proc/self/status", "utf8")).toBeTruthy();
	}, 120_000);
});

describe.skipIf(!usable)("chopin connect with a Planner command", () => {
	test(
		"builds the one image its agent and Planner share before it says Connected, and the Planner then starts with no build",
		async () => {
			let state = join(scratch, "connect-state");
			mkdirSync(state, { mode: 0o700 });
			/** What `images/` held when Chopin first heard of the machine. */
			let atConnection: string[] | undefined;
			let interrupted = false;
			let fake = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					let path = new URL(request.url).pathname;
					if (path === "/api/connector/connections") {
						atConnection ??= readdirSync(join(state, "images")).filter(name => name !== "cache");
						return Response.json({ token: "connection" });
					}
					if (path !== "/connector/mcp") return new Response(null, { status: 404 });
					let server = new Server({ name: "fake-chopin", version: "1" }, {
						capabilities: { tools: {} },
					});
					server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
					server.setRequestHandler(CallToolRequestSchema, async call => {
						if (call.params.name === "wait_for_work") {
							if (!interrupted) {
								interrupted = true;
								connector.kill("SIGINT");
							}
							await Bun.sleep(500);
						}
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
			let url = `http://127.0.0.1:${fake.port}`;
			writeFileSync(
				join(state, "machine.json"),
				JSON.stringify({
					servers: { [url]: { token: `chopin_m_${"M".repeat(43)}`, label: "vm" } },
				}),
			);
			let started = Date.now();
			let connector = Bun.spawn([
				process.execPath,
				"--no-env-file",
				join(import.meta.dir, "main.ts"),
				"connect",
				"--install",
				"true",
				"--planner-command",
				"git --version",
				"--planner-install",
				"true",
				"--no-planner-spare",
				"--",
				"node",
				"--version",
			], {
				cwd: scratch,
				env: { ...process.env, CHOPIN_HOME: state, CHOPIN_URL: url },
				stdout: "pipe",
				stderr: "pipe",
			});
			let [stdout, stderr] = await Promise.all([
				new Response(connector.stdout).text(),
				new Response(connector.stderr).text(),
				connector.exited,
			]);
			fake.stop(true);
			let connected = Date.now() - started;
			let lines = stdout.split("\n");
			let building = lines.filter(line => line.startsWith("… Building"));
			expect(building, `${stdout}${stderr}`).toEqual([
				"… Building one image for node and the Planner (git), whose installs are the same, for "
				+ "their microVMs (a minute or two, once, so the first document's Planner starts at once).",
			]);
			expect(lines.indexOf(building[0]!)).toBeLessThan(lines.indexOf("✓ Connected."));
			// Chopin heard of the machine once its one image was there, checked for both programs.
			let layer = atConnection!.find(name => name.endsWith(".erofs"))!;
			let key = layer.split(".")[0]!;
			expect(atConnection!.sort()).toEqual([layer, `${key}.json`]);
			let record = JSON.parse(readFileSync(join(state, "images", `${key}.json`), "utf8"));
			expect({ layer: record.layer, programs: record.programs }).toEqual({
				layer,
				programs: ["node", "git"],
			});

			// The service starts on what connect saved, finds the image, and the Planner starts in it.
			let settings = (await readConfig(state)).connect!;
			let said = "";
			let opening = Date.now();
			let machine = await openMachineSandbox({
				directory: state,
				server: url,
				recipes: machineRecipes({
					command: settings.command,
					plannerCommand: settings.plannerCommand,
					install: settings.install!,
					plannerInstall: settings.plannerInstall!,
				}),
				output: createOutput({ write: text => said += text }, { write: text => said += text }),
			});
			let opened = Date.now() - opening;
			try {
				// A folder of the launch's own, as a Planner's are: never one that holds the state directory.
				let folder = join(state, "planner-check");
				mkdirSync(folder);
				let launching = Date.now();
				let child = machine.spawn({
					command: settings.plannerCommand,
					cwd: folder,
					env: {},
					stdin: "ignore",
				});
				let out = "";
				child.stdout.on("data", chunk => out += chunk);
				let code = await new Promise(resolve => child.once("close", resolve));
				let launched = Date.now() - launching;
				expect({ code, out: out.trim().split(" ").slice(0, 2).join(" ") }).toEqual({
					code: 0,
					out: "git version",
				});
				expect(said).not.toContain("Building");
				console.log(
					`connect to Connected (one build): ${connected} ms; the service's start with the image `
						+ `built: ${opened} ms; the Planner's microVM to its exit: ${launched} ms`,
				);
			} finally {
				await machine.close();
			}
		},
		600_000,
	);
});

/**
 * A Planner backend in its microVM that takes spare mode, written for Node in the image: started as
 * a spare it notes what it was started with, prints the ready line and, when its stdin hands it a
 * document, reads its Planner credential from its file and tells the fake Chopin, through the
 * proxy, what it saw; started cold it tells it at once.
 */
const SPARE_BACKEND = `
const fs = require("node:fs");
const { dirname } = require("node:path");
const { execFileSync } = require("node:child_process");
const tell = body => fetch(process.env.CHOPIN_URL + "/attached", { method: "POST", body: JSON.stringify(body) });
const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.CHOPIN_WORKTREE }).toString().trim();
if (process.env.CHOPIN_PLANNER_SPARE === "1" && !process.env.CHOPIN_DOCUMENT) {
	const started = { document: process.env.CHOPIN_DOCUMENT ?? null, token: process.env.CHOPIN_PLANNER_TOKEN ?? null,
		tokens: fs.readdirSync(dirname(process.env.CHOPIN_PLANNER_TOKEN_FILE)) };
	process.stdout.write('chopin-planner-spare: ready {"protocol":1}\\n');
	require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
		const message = JSON.parse(line);
		if (message.type !== "assign") return;
		const token = fs.readFileSync(process.env.CHOPIN_PLANNER_TOKEN_FILE, "utf8").trim().split("\\n")[0];
		void tell({ how: "spare", document: message.document, token, started, head: head() });
	});
} else {
	void tell({ how: "cold", document: process.env.CHOPIN_DOCUMENT, token: process.env.CHOPIN_PLANNER_TOKEN, head: head() });
}
setInterval(() => {}, 1000);
`;

describe.skipIf(!usable)("spare Planners in microVMs", () => {
	test(
		"a repository the machine cloned keeps a spare in a microVM of its own, which holds nothing of a document until one is handed to it and attaches it sooner than a cold start",
		async () => {
			let name = `octo-org/spare-${Math.random().toString(36).slice(2, 8)}`;
			// The machine's clone of a repository it has no checkout of, as `chopin connect` makes one.
			let clone = clonePath(base, name);
			mkdirSync(clone, { recursive: true });
			git(clone, "init", "-q", "-b", "main");
			git(clone, "remote", "add", "origin", `https://github.com/${name}.git`);
			writeFileSync(join(clone, "README.md"), "the clone\n");
			git(clone, "add", ".");
			git(clone, "commit", "-qm", "initial");
			let commit = git(clone, "rev-parse", "HEAD");
			let attached: Array<Record<string, any> & { at: number }> = [];
			let states: SpareState[] = [];
			let fake = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					let path = new URL(request.url).pathname;
					if (path === "/attached") {
						attached.push({ ...await request.json() as Record<string, any>, at: Date.now() });
						return new Response("ok");
					}
					let answered = await answerTokens(request);
					if (answered) return answered;
					if (path === "/api/connector/planner") {
						let { document } = await request.json() as { document: string };
						return Response.json({
							token: `chopin_p_${document.padEnd(43, "P")}`,
							expiresAt: Date.now() + 15 * 60_000,
							document: { id: document, repository: name },
						});
					}
					return Response.json({});
				},
			});
			sandbox.allow?.(`127.0.0.1:${fake.port}`);
			let url = `http://127.0.0.1:${fake.port}`;
			let quiet = { write: () => true };
			let output = createOutput(quiet, quiet, {});
			let abort = new AbortController();
			let command = ["bash", "-c", `exec node -e '${SPARE_BACKEND.replaceAll("'", "'\\''")}'`];
			let spares = plannerSpares({
				url,
				command,
				registered: {},
				directory: base,
				output,
				signal: abort.signal,
				sandbox,
				replaceMs: 200,
				states: {
					record(next) {
						states = next;
						return Promise.resolve();
					},
				},
			});
			let resolved = { root: realpathSync(clone), env: {} };
			let serve = (document: string) =>
				servePlanners({
					url,
					machine: `chopin_m_${"M".repeat(43)}`,
					documents: [document],
					command,
					checkouts: { registered: {}, resolve: async () => resolved },
					directory: base,
					output,
					signal: abort.signal,
					sandbox,
					spares,
				});
			let until = async (condition: () => boolean, ms: number) => {
				for (let deadline = Date.now() + ms; !condition(); await Bun.sleep(20)) {
					if (Date.now() > deadline) throw new Error("timed out");
				}
			};
			try {
				// The first document of the repository starts cold: no Planner ran in it here yet.
				let asked = Date.now();
				let first = serve("D_cold");
				await until(() => attached.some(entry => entry.document === "D_cold"), 120_000);
				let cold = attached.find(entry => entry.document === "D_cold")!;
				expect(cold).toMatchObject({ how: "cold", head: commit });
				let coldMs = cold.at - asked;

				// Its repository keeps a spare from then on: a microVM booted on a disk of its own, its
				// backend waiting, with no document, no credential and an empty token folder.
				let ready = Date.now();
				await until(() => states.some(state => state.state === "ready"), 120_000);
				let second = Date.now();
				let next = serve("D_new");
				await until(() => attached.some(entry => entry.document === "D_new"), 120_000);
				let warm = attached.find(entry => entry.document === "D_new")!;
				let spareMs = warm.at - second;
				expect(warm).toMatchObject({
					how: "spare",
					token: `chopin_p_${"D_new".padEnd(43, "P")}`,
					head: commit,
					started: { document: null, token: null, tokens: [] },
				});
				console.log(
					`A new document's Planner attached ${coldMs} ms after it was asked for, cold; `
						+ `${spareMs} ms on the repository's spare (ready ${
							second - ready
						} ms after the cold one attached)`,
				);
				expect(spareMs).toBeLessThan(coldMs);
				abort.abort();
				await Promise.all([first, next]);
			} finally {
				abort.abort();
				await spares.stop();
				fake.stop(true);
				rmSync(join(base, "planners", ...name.split("/")), { recursive: true, force: true });
				rmSync(clone, { recursive: true, force: true });
			}
		},
		300_000,
	);
});
