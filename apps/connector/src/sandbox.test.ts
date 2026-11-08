import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxLabel } from "@chopin/protocol/connector";
import type { Host } from "./sandbox-probe";
import {
	connectorDenied,
	createSandbox,
	inspectSandbox,
	launchPolicy,
	locateExecutor,
	SandboxRefused,
	sdkRoot,
	spawnIn,
	systemHost,
} from "./sandbox";

let scratch = realpathSync(mkdtempSync(join(tmpdir(), "chopin-sandbox-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A machine with nothing a sandbox needs, so every probe says why not. */
function bare(): Host {
	return {
		...systemHost(),
		platform: "linux",
		arch: "x64",
		release: "6.8.0",
		read: () => undefined,
		exists: () => false,
		find: () => undefined,
		run: async () => ({ code: 0, output: "" }),
	};
}

function output(child: ReturnType<typeof spawnIn>) {
	return new Promise<{ text: string; code: number | null }>(done => {
		let text = "";
		child.stdout.on("data", chunk => text += chunk);
		child.once("close", code => done({ text, code }));
	});
}

test("with no sandbox to start it in, a process starts as it always did", async () => {
	let child = spawnIn(undefined, {
		command: [process.execPath, "-e", "console.log(process.env.CHOPIN_X + ' ' + process.cwd())"],
		cwd: scratch,
		env: { ...process.env, CHOPIN_X: "plain" },
		stdin: "ignore",
	});
	expect(await output(child)).toEqual({ text: `plain ${scratch}\n`, code: 0 });
});

test("where no sandbox works, runs go on unsandboxed and the report says why", async () => {
	let sandbox = await createSandbox({
		directory: scratch,
		server: "https://chopin.example.com",
		host: bare(),
		executor: "/opt/mxc/lxc-exec",
	});
	expect(sandbox.report.engine).toBe("none");
	expect(sandboxLabel(sandbox.report)).toStartWith("Not sandboxed: The Linux sandbox can't run:");
	let child = sandbox.spawn({
		command: [process.execPath, "-e", "console.log('ran')"],
		cwd: scratch,
		env: process.env,
		stdin: "ignore",
	});
	expect(await output(child)).toEqual({ text: "ran\n", code: 0 });
});

test("--require-sandbox refuses a run that has no sandbox, and says why and how to go on", async () => {
	let sandbox = await createSandbox({
		directory: scratch,
		server: "https://chopin.example.com",
		settings: { require: true },
		host: bare(),
		executor: "/opt/mxc/lxc-exec",
	});
	let launch = {
		command: [process.execPath, "-e", "process.exit(0)"],
		cwd: scratch,
		env: process.env,
		stdin: "ignore" as const,
	};
	expect(() => sandbox.spawn(launch)).toThrow(SandboxRefused);
	expect(() => sandbox.spawn(launch)).toThrow(
		"Not run: the sandbox is required (--require-sandbox) and The Linux sandbox can't run:",
	);
	// Off by default: the same machine without the option runs it.
	let lenient = await createSandbox({
		directory: scratch,
		server: "https://chopin.example.com",
		host: bare(),
		executor: "/opt/mxc/lxc-exec",
	});
	expect(await output(lenient.spawn(launch))).toMatchObject({ code: 0 });
});

test("--no-sandbox is a sandbox that says it is off, and --require-sandbox can't override it into a run", async () => {
	let off = await createSandbox({
		directory: scratch,
		server: "https://chopin.example.com",
		settings: { off: true },
		host: bare(),
	});
	expect(off.report).toEqual({ engine: "none", reason: "It is turned off with --no-sandbox." });
	expect((await inspectSandbox({ directory: scratch, settings: { off: true } })).report).toEqual(
		off.report,
	);
});

test("a chopin with no executor, such as the downloaded script, reports it rather than failing", async () => {
	let sandbox = await createSandbox({
		directory: scratch,
		server: "https://chopin.example.com",
		host: bare(),
		executor: undefined,
	});
	expect(sandbox.report).toMatchObject({
		engine: "none",
		reason: expect.stringContaining("no MXC executor"),
	});
});

test("an agent can't see another run's files or the machine token, only its own", () => {
	let base = join(scratch, "state");
	let tree: Record<string, string[]> = {
		[base]: ["machine.json", "machine.json.lock", "config.json", "runs", "planners", "repos"],
		[join(base, "runs")]: [
			"mine",
			"mine.json",
			"mine.github-token",
			"mine-worktrees",
			"other",
			"other.json",
		],
		[join(base, "planners")]: ["octo", "someone"],
		[join(base, "planners", "octo")]: ["score", "other-repo"],
		[join(base, "planners", "octo", "score")]: [
			"doc1",
			"doc1.planner-token",
			"doc2",
			"doc2.github-token",
		],
	};
	let list = (path: string) => tree[path] ?? [];
	let own = [join(base, "runs", "mine")];
	expect(connectorDenied(base, own, list)).toEqual([
		join(base, "machine.json"),
		join(base, "machine.json.lock"),
		join(base, "runs", "other"),
		join(base, "runs", "other.json"),
		join(base, "planners", "octo"),
		join(base, "planners", "someone"),
	]);
	// A Planner keeps the folder of its own document and denies its siblings by name.
	let planner = [join(base, "planners", "octo", "score", "doc1")];
	expect(connectorDenied(base, planner, list)).toEqual([
		join(base, "machine.json"),
		join(base, "machine.json.lock"),
		join(base, "runs", "mine"),
		join(base, "runs", "mine.json"),
		join(base, "runs", "mine.github-token"),
		join(base, "runs", "mine-worktrees"),
		join(base, "runs", "other"),
		join(base, "runs", "other.json"),
		join(base, "planners", "octo", "score", "doc2"),
		join(base, "planners", "octo", "score", "doc2.github-token"),
		join(base, "planners", "octo", "other-repo"),
		join(base, "planners", "someone"),
	]);
});

test("a launch may write its worktree, its repository's git directory, its agent's state and a private temporary directory", () => {
	let root = join(scratch, "launch");
	let base = join(root, "state");
	let checkout = join(root, "checkout");
	let git = (...args: string[]) =>
		spawnSync("git", [
			"-c",
			"commit.gpgsign=false",
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			...args,
		], {
			encoding: "utf8",
		});
	mkdirSync(checkout, { recursive: true });
	git("-C", checkout, "init", "-b", "main");
	writeFileSync(join(checkout, "a.txt"), "a");
	git("-C", checkout, "add", ".");
	git("-C", checkout, "commit", "-m", "init");
	mkdirSync(join(base, "runs", "mine-worktrees"), { recursive: true });
	mkdirSync(join(base, "runs", "other"), { recursive: true });
	writeFileSync(join(base, "machine.json"), "{}");
	let worktree = join(base, "runs", "mine");
	git("-C", checkout, "worktree", "add", "--detach", worktree);
	let temporary = join(root, "tmp");
	mkdirSync(temporary);
	let policy = launchPolicy(
		"bubblewrap",
		{ ...systemHost(), platform: "linux" },
		{
			command: ["atomic-acp"],
			cwd: worktree,
			env: { PATH: process.env.PATH, HOME: join(root, "home"), KEEP: "yes" },
			stdin: "pipe",
			writable: [join(base, "runs", "mine-worktrees")],
			own: [worktree],
		},
		{
			directory: base,
			home: join(root, "home"),
			settings: { writable: [join(root, "extra-missing")] },
		},
		"http://127.0.0.1:4000",
		temporary,
	);
	expect(policy.writable).toContain(worktree);
	expect(policy.writable).toContain(join(base, "runs", "mine-worktrees"));
	expect(policy.writable).toContain(join(checkout, ".git"));
	expect(policy.writable).toContain(temporary);
	expect(policy.writable).toContain(join(root, "home", ".atomic"));
	// A directory that isn't there is not granted: MXC would refuse the request.
	expect(policy.writable).not.toContain(join(root, "extra-missing"));
	expect(policy.readonlyInside).toEqual([join(checkout, ".git", "hooks")]);
	expect(policy.denied).toContain(join(base, "machine.json"));
	expect(policy.denied).toContain(join(base, "runs", "other"));
	expect(policy.denied).not.toContain(worktree);
	expect(policy.readable).toContain("/usr");
	expect(policy.readable).not.toContain("/tmp");
	expect(policy.readable).not.toContain("/dev");
	// Credentials are not hidden from the agent's own environment, and it gets a private TMPDIR.
	expect(policy.env.KEEP).toBe("yes");
	expect(policy.env.TMPDIR).toBe(temporary);
	expect(policy.env.NODE_USE_ENV_PROXY).toBe("1");
	expect(policy.proxy).toBe("http://127.0.0.1:4000");
});

test("the chopin binary carries MXC's executor, and a source checkout finds the one in the SDK package", async () => {
	let executor = await locateExecutor(scratch);
	let supported = ["linux", "darwin", "win32"].includes(process.platform)
		&& (process.arch === "x64" || process.arch === "arm64");
	if (!supported || (process.platform === "darwin" && process.arch !== "arm64")) {
		expect(executor).toBeUndefined();
		return;
	}
	expect(executor).toBeDefined();
	expect(existsSync(executor!)).toBe(true);
	expect(executor).toMatch(/(lxc-exec|mxc-exec-mac|wxc-exec\.exe)$/);
});

test("the SDK package is found by walking up node_modules, never by a resolver that would install it", () => {
	// A script run from a folder with no node_modules above it, as the downloaded one is, has none.
	expect(sdkRoot(scratch)).toBeUndefined();
	// A source checkout has it beside the connector's own sources.
	expect(sdkRoot(import.meta.dir)).toEndWith("/node_modules/@microsoft/mxc-sdk");
	let nested = join(scratch, "app", "node_modules", "@microsoft", "mxc-sdk");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), "{}");
	mkdirSync(join(scratch, "app", "src", "deep"), { recursive: true });
	expect(sdkRoot(join(scratch, "app", "src", "deep"))).toBe(nested);
});
