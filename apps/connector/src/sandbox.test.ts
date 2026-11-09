import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * What is held read-only in a launch's own worktree entry: the three files that say where git is
 * and the three directories the repository's git directory holds read-only too. Git writes the
 * rest of the entry's top level by taking a lock beside each file, so it is not held.
 */
function inEntry(entry: string) {
	return ["commondir", "config.worktree", "gitdir", "hooks", "info", "modules"].map(name =>
		join(entry, name)
	);
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
		policy(cwd: string, writable: string[] = [], own: string[] = [], added: string[] = []) {
			mkdirSync(join(root, "tmp"), { recursive: true });
			return launchPolicy(
				"bubblewrap",
				{ ...systemHost(), platform: "linux" },
				{ command: ["pdd-kit", "planner"], cwd, env: {}, stdin: "ignore", writable, own },
				{ directory: base, home: join(root, "home"), settings: { writable: added } },
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
	// directory, and its own worktree's directory there: not the directory whole, and not `worktrees`.
	for (let name of ["objects", "refs", "logs"]) {
		expect(policy.writable).toContain(join(checkout, ".git", name));
	}
	expect(policy.writable).toContain(join(checkout, ".git", "worktrees", "mine"));
	for (
		let path of [
			join(checkout, ".git"),
			join(checkout, ".git", "config"),
			join(checkout, ".git", "hooks"),
			join(checkout, ".git", "info"),
			join(checkout, ".git", "HEAD"),
			join(checkout, ".git", "worktrees"),
			join(checkout, ".git", "modules"),
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
	// What git reads to find its configuration, in what it may write: the worktree's pointer to its
	// git directory, and in that directory the files that say whose configuration it reads and where
	// the worktree is, and its own. The repository's own git directory is held whole, so its
	// `config`, `hooks` and `info` are not written at all.
	let entry = join(checkout, ".git", "worktrees", "mine");
	expect(held(policy)).toEqual(
		[
			join(checkout, ".git"),
			...inEntry(entry),
			join(worktree, ".git"),
		].sort(),
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

test("a launch in a checkout the connector did not make for it, the person's own, writes none of it: the checkout and its git directory are read-only whole, and no name in the git directory is granted", () => {
	let repo = repository("git-checkout");
	let before = readdirSync(repo.git).sort();
	let policy = repo.policy(repo.checkout);
	// Nothing in the checkout is written: not its files, not its `.git`, and with no worktree of its
	// own there is nothing to commit in, so not even where commits go.
	expect(
		policy.writable.filter(path => path === repo.checkout || path.startsWith(`${repo.checkout}/`)),
	)
		.toEqual([]);
	expect(policy.readable).toContain(repo.checkout);
	// The directory is held whole, so no file can be made at its top level, a `commondir` among them.
	expect(held(policy)).toEqual([repo.git]);
	// And nothing is made in it for the sandbox's sake.
	expect(readdirSync(repo.git).sort()).toEqual(before);
	expect(existsSync(join(repo.git, "config.worktree"))).toBe(false);
});

test("a Planner in the person's checkout writes its own worktree and where commits go in the repository's git directory, and nothing else of the repository", () => {
	let repo = repository("git-planner-checkout");
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(join(repo.base, "planners", "octo", "score"), { recursive: true });
	gitCommand("-C", repo.checkout, "worktree", "add", "--detach", planned);
	// A submodule's folder, with the `.git` file that sends the person's own git to its git directory.
	mkdirSync(join(repo.checkout, "vendor"));
	writeFileSync(join(repo.checkout, "vendor", ".git"), "gitdir: ../.git/modules/vendor\n");
	let before = readdirSync(repo.git).sort();
	let policy = repo.policy(repo.checkout, [planned], [planned]);
	expect(policy.writable).toContain(planned);
	expect(policy.writable).not.toContain(repo.checkout);
	expect(policy.writable).not.toContain(repo.git);
	// Where its worktree's commits, branches, fetched objects and LFS objects go, and its entry.
	for (let name of ["objects", "refs", "logs"]) {
		expect(policy.writable).toContain(join(repo.git, name));
	}
	expect(policy.writable).toContain(join(repo.git, "worktrees", "D_1"));
	for (
		let name of ["config", "hooks", "info", "HEAD", "index", "packed-refs", "worktrees", "modules"]
	) {
		expect(policy.writable).not.toContain(join(repo.git, name));
	}
	// Of the checkout itself, only the directories there are written, and none of its files.
	expect(
		policy.writable.filter(path => path.startsWith(`${repo.checkout}/`)).map(path =>
			path.slice(repo.checkout.length + 1)
		).sort(),
	).toEqual([
		".git/logs",
		".git/objects",
		".git/refs",
		".git/worktrees/D_1",
	]);
	expect(readdirSync(repo.git).sort()).toEqual(before);
});

test("a Planner's checkout inside the connector's state directory, which a clone the connector made is, is read by name and not written", () => {
	let repo = repository("git-planner-clone");
	// A clone is made in `<base>/repos/<owner>/<repo>`, where nothing is read but what is named.
	let clone = join(repo.base, "repos", "octo", "score");
	mkdirSync(join(repo.base, "repos", "octo"), { recursive: true });
	gitCommand("clone", "-q", repo.checkout, clone);
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(join(repo.base, "planners", "octo", "score"), { recursive: true });
	gitCommand("-C", clone, "worktree", "add", "--detach", planned);
	let policy = repo.policy(clone, [planned], [planned]);
	expect(policy.readable).toContain(clone);
	expect(policy.writable).not.toContain(clone);
	expect(policy.writable).toContain(planned);
});

test("the repository's lfs directory, where Git LFS keeps its objects, is written where it exists, and no name beside it, no new file at the top level and no lfs directory that isn't there is", () => {
	let repo = repository("git-lfs");
	mkdirSync(join(repo.git, "lfs", "objects"), { recursive: true });
	// Names that only resemble it, and a file git or an agent might add at the top level.
	mkdirSync(join(repo.git, "lfs-x"));
	writeFileSync(join(repo.git, "lfs.lock"), "");
	writeFileSync(join(repo.git, "new-file"), "");
	let beside = (policy: ReturnType<typeof launchPolicy>) =>
		policy.writable.filter(path => path.startsWith(`${repo.git}/`)).map(path =>
			path.slice(repo.git.length + 1)
		).sort();
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(join(repo.base, "planners", "octo", "score"), { recursive: true });
	gitCommand("-C", repo.checkout, "worktree", "add", "--detach", planned);
	let mine = repo.worktree("mine");
	let launches = [
		() => repo.policy(repo.checkout, [planned], [planned]),
		() => repo.policy(mine, [], [mine]),
	];
	for (let launch of launches) {
		// Only these four, and a worktree's own entry: `lfs-x`, `lfs.lock` and `new-file` are not.
		expect(beside(launch()).filter(name => !name.startsWith("worktrees/"))).toEqual([
			"lfs",
			"logs",
			"objects",
			"refs",
		]);
	}
	// Where there is none, none is granted and none is made for the sandbox's sake.
	rmSync(join(repo.git, "lfs"), { recursive: true });
	expect(beside(launches[0]!())).toEqual(["logs", "objects", "refs", "worktrees/D_1"]);
	expect(existsSync(join(repo.git, "lfs"))).toBe(false);
});

test("a launch in a linked worktree writes its own entry in the repository's git directory and no other: that is held, with the files in it that say where its configuration is, whatever the repository reads", () => {
	let repo = repository("git-worktree-config");
	let mine = repo.worktree("mine");
	let other = repo.worktree("other");
	let admin = (name: string) => join(repo.git, "worktrees", name);
	// The worktree is the connector's, made for this launch, which is what makes its entry the
	// launch's.
	let policy = repo.policy(mine, [], [mine]);
	expect(policy.writable).toContain(admin("mine"));
	expect(policy.writable).not.toContain(admin("other"));
	expect(policy.writable).not.toContain(join(repo.git, "worktrees"));
	// An empty `config.worktree` where there was none, which git ignores unless the repository reads
	// one, so an agent can't be the one to write it; and the files that say where git is held back.
	expect(readFileSync(join(admin("mine"), "config.worktree"), "utf8")).toBe("");
	expect(held(policy)).toEqual(
		[
			repo.git,
			...inEntry(admin("mine")),
			join(mine, ".git"),
		].sort(),
	);
	// Nothing is made in a sibling's entry, or in the repository's top level.
	expect(existsSync(join(admin("other"), "config.worktree"))).toBe(false);
	expect(existsSync(join(repo.git, "config.worktree"))).toBe(false);
	expect(held(policy)).not.toContain(join(other, ".git"));
	// One that already has such a file keeps what is in it.
	gitCommand("-C", repo.checkout, "config", "extensions.worktreeConfig", "true");
	writeFileSync(join(admin("mine"), "config.worktree"), "[core]\n\tsparseCheckout = true\n");
	repo.policy(mine, [], [mine]);
	expect(readFileSync(join(admin("mine"), "config.worktree"), "utf8")).toContain("sparseCheckout");
});

test("a Planner whose checkout is itself a linked worktree of the person's reads that checkout and its git entry and writes only its own worktree's entry", () => {
	let repo = repository("git-planner-linked");
	// The person's own checkout of the repository is a linked worktree, which is where the Planner
	// runs; the connector makes the Planner's worktree from it.
	let persons = join(repo.root, "persons-checkout");
	gitCommand("-C", repo.checkout, "worktree", "add", "--detach", persons);
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(join(repo.base, "planners", "octo", "score"), { recursive: true });
	gitCommand("-C", persons, "worktree", "add", "--detach", planned);
	let admin = (name: string) => join(repo.git, "worktrees", name);
	// The launch, as `planner.ts` makes it: the checkout is where it runs, and the worktree is its
	// own.
	let policy = repo.policy(persons, [planned], [planned]);
	expect(policy.writable).not.toContain(persons);
	expect(policy.readable).toContain(persons);
	expect(policy.writable).toContain(planned);
	expect(policy.writable).toContain(admin("D_1"));
	// The person's entry is theirs: its HEAD, index and any rebase in progress are what their own
	// git reads and runs, so nothing in it is written, and nothing is made in it for the sandbox's sake.
	expect(policy.writable.filter(path => path.startsWith(admin("persons-checkout")))).toEqual([]);
	expect(existsSync(join(admin("persons-checkout"), "config.worktree"))).toBe(false);
	expect(policy.writable).not.toContain(join(repo.git, "worktrees"));
	expect(policy.writable).not.toContain(repo.git);
	for (let name of ["objects", "refs", "logs"]) {
		expect(policy.writable).toContain(join(repo.git, name));
	}
	// The repository's git directory is held whole, as a regular checkout's is, so the person's
	// entry can't be renamed or made again either; the checkout, `.git` file included, is read-only
	// whole, and the Planner's own worktree's pointers are held, as a run's are.
	expect(held(policy)).toEqual(
		[
			repo.git,
			...inEntry(admin("D_1")),
			join(planned, ".git"),
		].sort(),
	);
});

test("a Planner's checkout whose .git is a symbolic link has its git directory granted by its real path, never through the link, and is read as any checkout is", () => {
	let repo = repository("git-symlink");
	// A checkout made by a tool that keeps the git directory elsewhere and links it in.
	let store = join(repo.root, "store", "checkout.git");
	mkdirSync(dirname(store));
	renameSync(repo.git, store);
	symlinkSync(join("..", "store", "checkout.git"), repo.git);
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(join(repo.base, "planners", "octo", "score"), { recursive: true });
	gitCommand("-C", repo.checkout, "worktree", "add", "--detach", planned);
	let policy = repo.policy(repo.checkout, [planned], [planned]);
	// Where commits go is named by the real directory, never through the link, which a sandbox
	// can't mount over and the agent could point elsewhere.
	for (let name of ["objects", "refs", "logs"]) {
		expect(policy.writable).toContain(join(store, name));
	}
	expect(held(policy)).toContain(store);
	for (let path of [...policy.writable, ...held(policy), ...policy.readable]) {
		expect(path === repo.git || path.startsWith(`${repo.git}/`)).toBe(false);
	}
	// The link is a name in the checkout, which is the person's: read whole, so no agent replaces it.
	// The Planner's own worktree, whose `.git` is a file that is held, is written.
	expect(policy.writable).not.toContain(repo.checkout);
	expect(policy.readable).toContain(repo.checkout);
	expect(policy.writable).toContain(planned);
	expect(policy.writable).toContain(join(store, "worktrees", "D_1"));
	expect(held(policy)).toContain(join(planned, ".git"));
});

test("one policy shape for every system: what a launch writes of its git directory is the same on Linux, macOS and Windows", () => {
	let repo = repository("git-shapes");
	let mine = repo.worktree("mine");
	let shape = (platform: NodeJS.Platform, cwd: string) => {
		let policy = launchPolicy(
			platform === "darwin" ? "seatbelt" : platform === "win32" ? "processcontainer" : "bubblewrap",
			{ ...systemHost(), platform },
			{
				command: ["pdd-kit", "planner"],
				cwd,
				env: {},
				stdin: "ignore",
				own: cwd === mine ? [mine] : [],
			},
			{ directory: repo.base, home: join(repo.root, "home") },
			"http://127.0.0.1:4000",
			join(repo.root, "tmp"),
		);
		let git = (paths: readonly string[]) => paths.filter(path => path.startsWith(repo.git)).sort();
		return {
			writable: git(policy.writable),
			held: held(policy),
			inGit: git(held(policy)),
			// Whether the working directory is written: the connector's own worktree, not the person's.
			writesWorkingDirectory: policy.writable.includes(cwd),
			readsWorkingDirectory: policy.readable.includes(cwd),
		};
	};
	for (let cwd of [mine, repo.checkout]) {
		let linux = shape("linux", cwd);
		expect(shape("darwin", cwd)).toEqual(linux);
		expect(shape("win32", cwd)).toEqual(linux);
		expect(linux.writesWorkingDirectory).toBe(cwd === mine);
		expect(linux.readsWorkingDirectory).toBe(cwd !== mine);
	}
});

test("on Windows a launch reads, of a checkout outside every directory it is given, its repository's git directory whole and nothing else of it: a run its worktree, a Planner its working directory", () => {
	let repo = repository("windows-reads");
	let mine = repo.worktree("mine");
	let windows = (cwd: string, own: string[]) =>
		launchPolicy(
			"processcontainer",
			{ ...systemHost(), platform: "win32" },
			{ command: ["atomic-acp"], cwd, env: {}, stdin: "ignore", own },
			{ directory: repo.base, home: join(repo.root, "home") },
			"http://127.0.0.1:4000",
			join(repo.root, "tmp"),
		);
	// A run: its worktree is written, which reads it; the checkout is not granted, but the git
	// directory it came from is, since the worktree's `.git` leads into it, and that is read whole:
	// its configuration, hooks, objects, and every worktree's entry.
	let run = windows(mine, [mine]);
	expect(run.writable).toContain(mine);
	expect(run.readable).toEqual([repo.git]);
	// A Planner works in the person's checkout, which is read whole with its git directory.
	let planner = windows(repo.checkout, []);
	expect([...planner.readable].sort()).toEqual([repo.checkout, repo.git].sort());
});

test("a Planner's own worktree, found made in its checkout's repository, is written as a run's is: its entry and no other, and its .git file is held", () => {
	let repo = repository("git-planner-worktree");
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(join(repo.base, "planners", "octo", "score"), { recursive: true });
	gitCommand("-C", repo.checkout, "worktree", "add", "--detach", planned);
	let persons = repo.worktree("persons");
	let policy = repo.policy(repo.checkout, [planned], [planned]);
	let admin = (name: string) => join(repo.git, "worktrees", name);
	expect(policy.writable).not.toContain(repo.checkout);
	expect(policy.writable).toContain(planned);
	expect(policy.writable).toContain(admin("D_1"));
	expect(policy.writable).not.toContain(admin("persons"));
	expect(policy.writable).not.toContain(join(repo.git, "worktrees"));
	expect(held(policy)).toEqual(
		[
			repo.git,
			...inEntry(admin("D_1")),
			join(planned, ".git"),
		].sort(),
	);
	expect(held(policy)).not.toContain(join(persons, ".git"));
});

test("a submodule's git directory and every worktree entry but the launch's own are read-only, as the rest of the git directory is: nothing of theirs is granted", () => {
	let repo = repository("git-submodules");
	let mine = repo.worktree("mine");
	repo.worktree("theirs");
	let gitDirectory = (...parts: string[]) => {
		let path = join(...parts);
		mkdirSync(join(path, "hooks"), { recursive: true });
		writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(path, "config"), "[core]\n");
		return path;
	};
	gitDirectory(repo.git, "modules", "lib");
	gitDirectory(repo.git, "modules", "ext", "tool");
	for (let cwd of [repo.checkout, mine]) {
		let policy = repo.policy(cwd, [], cwd === mine ? [mine] : []);
		expect(policy.writable.filter(path => path.startsWith(join(repo.git, "modules")))).toEqual([]);
		expect(policy.writable).not.toContain(join(repo.git, "worktrees", "theirs"));
		expect(policy.writable.filter(path => path.startsWith(join(repo.git, "worktrees", "theirs"))))
			.toEqual([]);
	}
});

test("a git directory named by a file in a folder the agent made earlier is not believed: only the working directory says which repository this is", () => {
	let repo = repository("git-pointer");
	let mine = repo.worktree("mine");
	let other = repository("git-pointer-other");
	// A Planner's worktree, as a backend left it, now pointing at another repository's git directory.
	let planned = join(repo.base, "planners", "octo", "score", "D_1");
	mkdirSync(planned, { recursive: true });
	writeFileSync(join(planned, ".git"), `gitdir: ${other.git}\n`);
	let policy = repo.policy(mine, [planned], [mine]);
	expect(policy.writable).toContain(planned);
	expect(policy.writable).toContain(join(repo.git, "objects"));
	expect(policy.writable).not.toContain(other.git);
	expect(policy.writable.filter(path => path.startsWith(other.git))).toEqual([]);
	expect(held(policy).filter(path => path.startsWith(other.git))).toEqual([]);
});

test("a launch whose working directory holds the connector's state directory, as a home does, is given what is around it by name and never the state directory or a parent of it", () => {
	let root = join(readableScratch, "ancestor");
	let home = join(root, "home");
	let base = join(home, ".local", "state", "chopin", "connector");
	mkdirSync(join(base, "runs", "other-run"), { recursive: true });
	writeFileSync(join(base, "machine.json"), "{}");
	writeFileSync(join(base, "runs", "other-run", "token"), "ghu_other");
	mkdirSync(join(home, "notes"), { recursive: true });
	mkdirSync(join(home, ".local", "share"), { recursive: true });
	mkdirSync(join(home, ".local", "state", "other"), { recursive: true });
	for (let platform of ["linux", "darwin"] as const) {
		let policy = launchPolicy(
			platform === "darwin" ? "seatbelt" : "bubblewrap",
			{ ...systemHost(), platform },
			{ command: ["pdd-kit", "planner"], cwd: home, env: {}, stdin: "ignore" },
			{ directory: base, home },
			"http://127.0.0.1:4000",
			join(root, "tmp"),
		);
		// No grant is the state directory or holds it, whole, and nothing in it is named.
		for (let path of policy.readable) {
			expect(base === path || base.startsWith(`${path}/`), `${platform}: ${path}`).toBe(false);
			expect(path.startsWith(`${base}/`), `${platform}: ${path}`).toBe(false);
		}
		// What is around the way to it is read, as the working directory is the launch's to read.
		for (
			let path of [
				join(home, "notes"),
				join(home, ".local", "share"),
				join(home, ".local", "state", "other"),
			]
		) {
			expect(policy.readable, platform).toContain(path);
		}
		expect(policy.writable.some(path => path === home || path.startsWith(`${base}`))).toBe(false);
	}
	// A directory the owner adds with --sandbox-write that holds the state directory, `~` itself,
	// is written around it and never in it (a launch that works elsewhere than in `~`, which would
	// be its checkout and never written).
	mkdirSync(join(root, "work"));
	let owner = launchPolicy(
		"bubblewrap",
		{ ...systemHost(), platform: "linux" },
		{ command: ["pdd-kit", "planner"], cwd: join(root, "work"), env: {}, stdin: "ignore" },
		{ directory: base, home, settings: { writable: [home] } },
		"http://127.0.0.1:4000",
		join(root, "tmp"),
	);
	expect(owner.writable).toContain(join(home, "notes"));
	for (let path of owner.writable) {
		expect(base === path || base.startsWith(`${path}/`), path).toBe(false);
		expect(path.startsWith(`${base}/`), path).toBe(false);
	}
});

test("a working directory inside the state directory is read by name only where it is a clone the connector made, and not at all elsewhere in it", () => {
	let root = join(readableScratch, "inside");
	let base = join(root, "state");
	let clone = join(base, "repos", "octo", "score");
	let other = join(base, "runs", "other-run");
	mkdirSync(clone, { recursive: true });
	mkdirSync(other, { recursive: true });
	writeFileSync(join(other, "token"), "ghu_other");
	let policy = (cwd: string) =>
		launchPolicy(
			"bubblewrap",
			{ ...systemHost(), platform: "linux" },
			{ command: ["pdd-kit", "planner"], cwd, env: {}, stdin: "ignore" },
			{ directory: base, home: join(root, "home") },
			"http://127.0.0.1:4000",
			join(root, "tmp"),
		);
	expect(policy(clone).readable).toContain(clone);
	for (let cwd of [other, base, join(base, "repos"), join(base, "runs")]) {
		let granted = policy(cwd).readable;
		expect(granted.filter(path => path === base || path.startsWith(`${base}/`)), cwd).toEqual([]);
		expect(granted.filter(path => base.startsWith(`${path}/`)), cwd).toEqual([]);
	}
});

test("a path the owner adds with --sandbox-write never makes the person's checkout writable: one that is it or inside it, or inside its git directory, is not granted, and one that holds it is granted with the checkout held read-only", () => {
	let repo = repository("git-added");
	mkdirSync(join(repo.checkout, "vendor"));
	let granted = join(repo.root, "granted");
	mkdirSync(granted);
	let mine = repo.worktree("mine");
	let under = (policy: ReturnType<typeof launchPolicy>) =>
		policy.writable.filter(path => path === repo.checkout || path.startsWith(`${repo.checkout}/`));
	// A Planner in the checkout and a run in a worktree of it: the checkout is the person's in both.
	for (
		let launch of [
			(added: string[]) => repo.policy(repo.checkout, [], [], added),
			(added: string[]) => repo.policy(mine, [], [mine], added),
		]
	) {
		let alone = under(launch([]));
		for (
			let added of [
				[join(repo.checkout, "vendor")],
				[repo.checkout],
				[repo.git],
				[join(repo.git, "hooks")],
				[join(repo.git, "modules", "lib")],
			]
		) {
			let policy = launch([...added, granted]);
			// Nothing of the checkout is written that was not before, and the rest is given.
			expect(under(policy), added.join()).toEqual(alone);
			expect(policy.writable, added.join()).toContain(granted);
		}
		// A folder that holds the checkout is written, around the state directory, and the checkout
		// and its git directory are held read-only inside it.
		let holder = launch([repo.root]);
		expect(holder.writable).toContain(granted);
		expect(under(holder)).toEqual(alone);
		expect(holder.writable).not.toContain(repo.root);
	}
	let nested = repository("git-added-nested");
	let outer = join(nested.root, "src");
	mkdirSync(outer);
	renameSync(nested.checkout, join(outer, "proj"));
	let moved = launchPolicy(
		"bubblewrap",
		{ ...systemHost(), platform: "linux" },
		{
			command: ["pdd-kit", "planner"],
			cwd: join(outer, "proj"),
			env: {},
			stdin: "ignore",
			own: [],
		},
		{ directory: nested.base, home: join(nested.root, "home"), settings: { writable: [outer] } },
		"http://127.0.0.1:4000",
		join(nested.root, "tmp"),
	);
	expect(moved.writable).toContain(outer);
	expect(held(moved)).toContain(join(outer, "proj"));
	expect(held(moved)).toContain(join(outer, "proj", ".git"));
});

test("a worktree beside the state directory is written and not also granted to read, which MXC would take as read-only", () => {
	let root = join(readableScratch, "beside");
	let base = join(root, "state");
	let checkout = join(root, "score");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(base);
	let policy = launchPolicy(
		"bubblewrap",
		{ ...systemHost(), platform: "linux" },
		{ command: ["pdd-kit", "planner"], cwd: checkout, env: {}, stdin: "ignore", own: [checkout] },
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
