import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { builtInRecipe } from "./images";
import { artifactsAt } from "./nvx";
import { AgentStore } from "./machine-store";
import { plannerEnvironment } from "./planner";
import { createSandbox, type Launch, type Sandbox } from "./sandbox";

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

let scratch = mkdtempSync(join(tmpdir(), "chopin-nvx-vm-"));
let base = process.env.CHOPIN_NVX_TEST_BASE ?? join(scratch, "state");
let sandbox: Sandbox;
let chopin: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let repository = join(scratch, "repo");

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
	sandbox = await createSandbox({
		directory: base,
		server: `http://127.0.0.1:${chopin.port}`,
		setup: { artifacts: artifacts!, hypervisor: "kvm" },
		recipes: new Map([["bash", { ...recipe, programs: ["bash"] }]]),
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

	test("ending a launch ends its microVM, OpenVMM included", async () => {
		let tokens = join(base, "runs", "vm-end.tokens");
		mkdirSync(tokens, { recursive: true });
		let child = sandbox.spawn({
			command: ["bash", "-c", "echo up; sleep 600"],
			cwd: tokens,
			env: {},
			stdin: "ignore",
			own: [tokens],
		});
		await new Promise<void>(resolve => child.stdout.once("data", () => resolve()));
		let group = child.pid!;
		let members = () =>
			spawnSync("ps", ["-o", "pid=", "-g", String(group)], { encoding: "utf8" }).stdout.trim();
		expect(members()).not.toBe("");
		let ended = Date.now();
		process.kill(-group, "SIGKILL");
		while (members() && Date.now() - ended < 5_000) await Bun.sleep(100);
		expect(members()).toBe("");
		expect(readdirSync(join(base, "nvx", "launches"))).toEqual([]);
	}, 120_000);

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
