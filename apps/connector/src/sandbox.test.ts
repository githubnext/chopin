import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxLabel } from "@chopin/protocol/connector";
import type { Host } from "./sandbox-probe";
import {
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
/** Under a root the sandbox reads on Linux and macOS, as a home or a state directory is; /tmp is not one. */
let readableScratch = existsSync("/var/tmp")
	? realpathSync(mkdtempSync("/var/tmp/chopin-sandbox-test-"))
	: scratch;
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
	rmSync(readableScratch, { recursive: true, force: true });
});

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

/** What a launch is not allowed to write inside a directory it may, sorted. */
function held(policy: ReturnType<typeof launchPolicy>) {
	return [...policy.readonlyInside ?? []].sort();
}

function gitCommand(...args: string[]) {
	let result = spawnSync("git", [
		"-c",
		"commit.gpgsign=false",
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		...args,
	], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/** A checkout with one commit, and the policy of a launch in any directory of it. */
function repository(name: string) {
	let root = join(readableScratch, name);
	let checkout = join(root, "checkout");
	let base = join(root, "state");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(base, { recursive: true });
	gitCommand("-C", checkout, "init", "-b", "main");
	writeFileSync(join(checkout, "a.txt"), "a");
	gitCommand("-C", checkout, "add", ".");
	gitCommand("-C", checkout, "commit", "-m", "init");
	return {
		root,
		checkout,
		base,
		git: join(checkout, ".git"),
		worktree(name: string) {
			let path = join(base, "runs", name);
			gitCommand("-C", checkout, "worktree", "add", "--detach", path);
			return path;
		},
		policy(cwd: string, writable: string[] = []) {
			mkdirSync(join(root, "tmp"), { recursive: true });
			return launchPolicy(
				"bubblewrap",
				{ ...systemHost(), platform: "linux" },
				{ command: ["pdd-kit", "planner"], cwd, env: {}, stdin: "ignore", writable },
				{ directory: base, home: join(root, "home") },
				"http://127.0.0.1:4000",
				join(root, "tmp"),
			);
		},
	};
}

test("a launch may write its worktree, its repository's git directory, its agent's state and a private temporary directory", () => {
	let root = join(readableScratch, "launch");
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
	mkdirSync(join(root, "notes"));
	let worktree = join(base, "runs", "mine");
	let tokens = `${worktree}.tokens`;
	mkdirSync(tokens);
	writeFileSync(join(tokens, "github"), "ghu_mine\n");
	git("-C", checkout, "worktree", "add", "--detach", worktree);
	// A Planner's worktree isn't there yet: the sandbox makes the folder it is made in.
	let planned = join(base, "planners", "octo", "score", "D_1");
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
			writable: [join(base, "runs", "mine-worktrees"), planned],
			own: [worktree, tokens],
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
	expect(policy.writable).toContain(planned);
	expect(existsSync(planned)).toBe(true);
	// A linked worktree's launch writes where commits and refs go, in the repository's git
	// directory, and its worktrees' own, not the directory whole.
	for (let name of ["objects", "refs", "logs", "worktrees"]) {
		expect(policy.writable).toContain(join(checkout, ".git", name));
	}
	for (
		let path of [
			join(checkout, ".git"),
			join(checkout, ".git", "config"),
			join(checkout, ".git", "hooks"),
			join(checkout, ".git", "info"),
			join(checkout, ".git", "HEAD"),
		]
	) {
		expect(policy.writable).not.toContain(path);
	}
	// And the rest of it is read, by name, since a system that reads only some roots has it in none.
	expect(policy.readable).toContain(join(checkout, ".git"));
	expect(policy.writable).toContain(temporary);
	expect(policy.writable).toContain(join(root, "home", ".atomic"));
	// A directory that isn't there is not granted: MXC would refuse the request.
	expect(policy.writable).not.toContain(join(root, "extra-missing"));
	// What git reads to decide which programs to run, in what it may write: the worktree's pointer
	// to its git directory and the file in that directory that says whose configuration it reads.
	// The repository's own `config`, `hooks` and `info` are not written at all.
	expect(held(policy)).toEqual(
		[join(checkout, ".git", "worktrees", "mine", "commondir"), join(worktree, ".git")].sort(),
	);
	expect(policy.readable).toContain("/usr");
	// What is around the state directory is read, and what is in it only by name: the launch's
	// tokens, as a folder, and nothing about any other run, the machine token or what comes later.
	expect(policy.readable).toContain(join(root, "notes"));
	expect(policy.readable.filter(path => path.startsWith(`${base}/`))).toEqual([tokens]);
	for (let path of policy.readable) {
		expect(base === path || base.startsWith(`${path}/`)).toBe(false);
	}
	expect(policy.denied.filter(path => path.startsWith(`${base}/`))).toEqual([]);
	expect(policy.readable).not.toContain("/tmp");
	expect(policy.readable).not.toContain("/dev");
	// Credentials are not hidden from the agent's own environment, and it gets a private TMPDIR.
	expect(policy.env.KEEP).toBe("yes");
	expect(policy.env.TMPDIR).toBe(temporary);
	expect(policy.env.NODE_USE_ENV_PROXY).toBe("1");
	expect(policy.proxy).toBe("http://127.0.0.1:4000");
});

test("in a checkout's own git directory git's configuration, hooks and attributes are read-only, and the rest, where commits and refs go, is not", () => {
	let repo = repository("git-checkout");
	let policy = repo.policy(repo.checkout);
	expect(held(policy)).toEqual([
		join(repo.git, "config"),
		join(repo.git, "hooks"),
		join(repo.git, "info"),
	].sort());
	// The directory itself is written, and so is the checkout's, whose `.git` is not held back.
	expect(policy.writable).toContain(repo.git);
	expect(policy.writable).toContain(repo.checkout);
	expect(held(policy)).not.toContain(join(repo.checkout, ".git"));
	// A path granted to read and to write is taken as read-only, so the directory isn't also read.
	expect(policy.readable).not.toContain(repo.git);
});

test("a repository that reads a configuration per worktree gets an empty one in each linked worktree's git directory, so an agent can't be the one to write it", () => {
	let repo = repository("git-worktree-config");
	gitCommand("-C", repo.checkout, "config", "extensions.worktreeConfig", "true");
	let mine = repo.worktree("mine");
	let other = repo.worktree("other");
	let policy = repo.policy(mine);
	let admin = (name: string) => join(repo.git, "worktrees", name);
	for (let directory of [admin("mine"), admin("other")]) {
		expect(readFileSync(join(directory, "config.worktree"), "utf8")).toBe("");
		expect(held(policy)).toContain(join(directory, "config.worktree"));
		// And the pointer to the configuration each reads, those of its siblings too.
		expect(held(policy)).toContain(join(directory, "commondir"));
	}
	expect(held(policy)).toContain(join(mine, ".git"));
	expect(held(policy)).not.toContain(join(other, ".git"));
	// The repository's own is not the launch's to write, so nothing is made there.
	expect(existsSync(join(repo.git, "config.worktree"))).toBe(false);
	// One that already has such a file keeps what is in it.
	writeFileSync(join(admin("other"), "config.worktree"), "[core]\n\tsparseCheckout = true\n");
	repo.policy(mine);
	expect(readFileSync(join(admin("other"), "config.worktree"), "utf8")).toContain("sparseCheckout");
	// A launch in the checkout itself writes its git directory whole, and so gets its own.
	let inCheckout = repo.policy(repo.checkout);
	expect(readFileSync(join(repo.git, "config.worktree"), "utf8")).toBe("");
	expect(held(inCheckout)).toContain(join(repo.git, "config.worktree"));
});

test("a repository that doesn't read a configuration per worktree is not given empty files it never reads", () => {
	let repo = repository("git-no-worktree-config");
	let mine = repo.worktree("mine");
	let policy = repo.policy(mine);
	expect(existsSync(join(repo.git, "config.worktree"))).toBe(false);
	expect(existsSync(join(repo.git, "worktrees", "mine", "config.worktree"))).toBe(false);
	expect(held(policy).filter(path => path.endsWith("config.worktree"))).toEqual([]);
});

test("a repository without a hooks or info directory gets an empty one, which is then read-only like the rest", () => {
	let repo = repository("git-bare-bones");
	rmSync(join(repo.git, "hooks"), { recursive: true });
	rmSync(join(repo.git, "info"), { recursive: true });
	let policy = repo.policy(repo.checkout);
	expect(existsSync(join(repo.git, "hooks"))).toBe(true);
	expect(existsSync(join(repo.git, "info"))).toBe(true);
	expect(held(policy)).toContain(join(repo.git, "hooks"));
	expect(held(policy)).toContain(join(repo.git, "info"));
});

test("a submodule's git directory, nested ones and one named with a slash included, is read-only in a checkout's launch, and not written at all in a linked worktree's", () => {
	let repo = repository("git-submodules");
	let mine = repo.worktree("mine");
	let gitDirectory = (...parts: string[]) => {
		let path = join(...parts);
		mkdirSync(join(path, "hooks"), { recursive: true });
		writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(path, "config"), "[core]\n");
		return path;
	};
	let lib = gitDirectory(repo.git, "modules", "lib");
	let nested = gitDirectory(lib, "modules", "deep");
	let slashed = gitDirectory(repo.git, "modules", "ext", "tool");
	let policy = repo.policy(repo.checkout);
	for (let module of [lib, nested, slashed]) {
		expect(held(policy)).toContain(join(module, "config"));
		expect(held(policy)).toContain(join(module, "hooks"));
	}
	// The folder a slashed name makes isn't a git directory, and its refs and objects are written.
	expect(held(policy)).not.toContain(join(repo.git, "modules", "ext", "config"));
	expect(policy.writable).toContain(repo.git);
	expect(held(policy)).not.toContain(join(lib, "objects"));
	// A launch in a linked worktree writes none of the submodules' git directories.
	let linked = repo.policy(mine);
	expect(linked.writable).not.toContain(join(repo.git, "modules"));
	expect(linked.writable.filter(path => path.startsWith(join(repo.git, "modules")))).toEqual([]);
});

test("a git directory named by a file in a folder the agent made earlier is not believed: only the working directory says which repository this is", () => {
	let repo = repository("git-pointer");
	let mine = repo.worktree("mine");
	let other = repository("git-pointer-other");
	// A Planner's worktree, as a backend left it, now pointing at another repository's git directory.
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(planned, { recursive: true });
	writeFileSync(join(planned, ".git"), `gitdir: ${other.git}\n`);
	let policy = repo.policy(mine, [planned]);
	expect(policy.writable).toContain(planned);
	expect(policy.writable).toContain(join(repo.git, "objects"));
	expect(policy.writable).not.toContain(other.git);
	expect(policy.writable.filter(path => path.startsWith(other.git))).toEqual([]);
	expect(held(policy).filter(path => path.startsWith(other.git))).toEqual([]);
});

test("a checkout beside the state directory is written and not also granted to read, which MXC would take as read-only", () => {
	let root = join(readableScratch, "beside");
	let base = join(root, "state");
	let checkout = join(root, "score");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(base);
	let policy = launchPolicy(
		"bubblewrap",
		{ ...systemHost(), platform: "linux" },
		{ command: ["pdd-kit", "planner"], cwd: checkout, env: {}, stdin: "ignore" },
		{ directory: base, home: join(root, "home") },
		"http://127.0.0.1:4000",
		join(root, "tmp"),
	);
	expect(policy.writable).toContain(checkout);
	expect(policy.readable).not.toContain(checkout);
	// The agent's state directory, a child of the home the grants walk through, is the same.
	let home = join(root, "home");
	let again = launchPolicy(
		"bubblewrap",
		{ ...systemHost(), platform: "linux" },
		{ command: ["atomic-acp"], cwd: checkout, env: {}, stdin: "ignore" },
		{ directory: join(home, ".local", "state", "chopin"), home },
		"http://127.0.0.1:4000",
		join(root, "tmp"),
	);
	expect(again.writable).toContain(join(home, ".atomic"));
	expect(again.readable).not.toContain(join(home, ".atomic"));
	expect(again.readable).not.toContain(join(home, ".local", "state", "chopin"));
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
