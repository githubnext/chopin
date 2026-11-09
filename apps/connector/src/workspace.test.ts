import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync as writeFileSyncNow,
} from "node:fs";
import {
	connectors,
	discardWorkspace,
	endWorkspace,
	git,
	lockWorkspace,
	noPushEnvironment,
	preparePlannerWorktree,
	prepareWorkspace,
	processStart,
	pruneRuns,
	workspace,
} from "./workspace";
import { worktreeEntry } from "./git-directories";
import { gitAsync } from "./git-host";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";

test("isolates exact source and allows an authorized retry without executing an attempt twice", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-workspace-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
		await writeFile(join(root, "source.txt"), "committed");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		await writeFile(join(root, "source.txt"), "user work");
		let info = await workspace(root);
		expect(info.repository).toBe("org/repo");
		let release = await lockWorkspace(root, state);
		await expect(lockWorkspace(root, state)).rejects.toThrow("already locked");
		let input = {
			id: crypto.randomUUID(),
			documentId: crypto.randomUUID(),
			brief: "Inspect",
			context: "",
			requester: "u",
			authorizer: "u",
			source: { repositoryId: "r", repository: info.repository, commit: info.commit },
		};
		let prepared = await prepareWorkspace(root, state, input);
		expect(await readFile(join(prepared.path, "source.txt"), "utf8")).toBe("committed");
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("user work");
		await expect(prepareWorkspace(root, state, input)).rejects.toThrow("already accepted");
		await writeFile(join(prepared.path, "source.txt"), "first attempt's work");
		let retried = await prepareWorkspace(root, state, input, 2);
		expect(retried.path).not.toBe(prepared.path);
		expect(await readFile(join(retried.path, "source.txt"), "utf8")).toBe("committed");
		expect(await readFile(join(prepared.path, "source.txt"), "utf8")).toBe("first attempt's work");
		await expect(prepareWorkspace(root, state, input, 2)).rejects.toThrow("already accepted");
		await release();
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

/** A checkout of octo-org/score whose commit is the run's source, as `prepareWorkspace` is given it. */
async function scoreCheckout() {
	let root = await mkdtemp(join(tmpdir(), "chopin-hardened-root-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-hardened-state-"));
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "file.txt"), "base");
	git(root, "add", ".");
	git(root, "commit", "-m", "base");
	let source = {
		repositoryId: "R_1",
		repository: "octo-org/score",
		commit: git(root, "rev-parse", "HEAD"),
	};
	return { root, state, source };
}

test("a run isn't started in a checkout whose git directory an agent gave a commondir: it is removed, and the run goes on once it is asked again", async () => {
	let { root, state, source } = await scoreCheckout();
	try {
		let planted = join(root, ".git", "commondir");
		writeFileSyncNow(planted, `${join(state, "elsewhere")}\n`);
		await expect(prepareWorkspace(root, state, { id: "r1", source })).rejects.toThrow(
			`an agent had made ${planted}`,
		);
		expect(existsSync(planted)).toBe(false);
		// Nothing of the refused run was begun, so the same run is accepted when it is sent again.
		expect(existsSync(join(state, "runs", "r1.json"))).toBe(false);
		let prepared = await prepareWorkspace(root, state, { id: "r1", source });
		expect(existsSync(join(prepared.path, "file.txt"))).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("the programs a checkout's configuration names don't run when the connector adds, ends and removes a run's worktree, or discards a spike's", async () => {
	let { root, state, source } = await scoreCheckout();
	try {
		let ran = join(state, "ran");
		let evil = join(state, "evil");
		mkdirSync(ran);
		mkdirSync(evil);
		for (let name of ["post-checkout", "reference-transaction", "fsmonitor"]) {
			writeFileSyncNow(join(evil, name), `#!/bin/sh\ntouch '${ran}/${name}'\n`);
			chmodSync(join(evil, name), 0o755);
		}
		git(root, "config", "core.hooksPath", evil);
		git(root, "config", "core.fsmonitor", join(evil, "fsmonitor"));
		let prepared = await prepareWorkspace(root, state, { id: "h1", source });
		git(prepared.path, "checkout", "-b", "chopin/implement-h1");
		await endWorkspace(root, prepared);
		let spike = await prepareWorkspace(root, state, { id: "h2", source });
		git(spike.path, "checkout", "-b", "chopin/spike-h2");
		await discardWorkspace(root, spike.path, "chopin/spike-h2");
		await endWorkspace(root, await prepareWorkspace(root, state, { id: "h3", source }));
		expect(await pruneRuns(state, 1)).toEqual(["h1"]);
		expect(readdirSync(ran)).toEqual([]);
		// The fixture is live: git with no say of the connector's runs the hooks.
		spawnSync("git", ["-C", root, "worktree", "add", "--detach", join(state, "plain")], {
			encoding: "utf8",
		});
		expect(readdirSync(ran)).toEqual(expect.arrayContaining(["fsmonitor", "post-checkout"]));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("names an agent makes at the top of its worktree's own git entry, which a sandbox can't refuse, make the connector's git run nothing: status, fetch, the next run's worktree, a run's end, a prototype's removal and retention, with an unfinished rebase's exec line among them", async () => {
	let { root, state, source } = await scoreCheckout();
	try {
		let ran = join(state, "ran");
		mkdirSync(ran);
		let common = join(root, ".git");
		let plain = (cwd: string, ...args: string[]) =>
			spawnSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], {
				encoding: "utf8",
				env: {
					...process.env,
					GIT_SEQUENCE_EDITOR:
						`sh -c 'printf "break\\nexec touch ${ran}/rebase-exec\\n" > "$1"' sh`,
				},
			});
		// What an agent in the sandbox can make in its own entry: any name, which nothing there is
		// a pointer or a configuration for, and a rebase it leaves unfinished, whose todo has an
		// `exec` line, which git run in that worktree would run on `rebase --continue`.
		let plant = (path: string) => {
			let entry = worktreeEntry(common, path)!;
			for (let name of ["post-checkout", "post-commit", "reference-transaction", "pre-commit"]) {
				writeFileSyncNow(join(entry, name), `#!/bin/sh\ntouch '${ran}/entry-${name}'\n`);
				chmodSync(join(entry, name), 0o755);
			}
			writeFileSyncNow(join(entry, "future-pointer"), "x");
			writeFileSyncNow(join(entry, "locked"), "planted by an agent\n");
			expect(plain(path, "rebase", "-i", "--root").status).toBe(0);
			expect(readFileSync(join(entry, "rebase-merge", "git-rebase-todo"), "utf8")).toContain(
				"exec touch",
			);
			return entry;
		};
		let first = await prepareWorkspace(root, state, { id: "p1", source });
		let entry = plant(first.path);
		expect(plain(first.path, "status").stdout).toContain("rebase in progress");
		// The connector's git, in the worktree and from the checkout.
		git(first.path, "status");
		git(first.path, "log", "-1");
		let remote = join(state, "remote.git");
		spawnSync("git", ["init", "-q", "--bare", remote]);
		plain(root, "push", "-q", remote, "HEAD:refs/heads/main");
		await gitAsync(["fetch", remote, "+refs/heads/*:refs/remotes/fixture/*"], {
			cwd: root,
			env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
		});
		let spike = await prepareWorkspace(root, state, { id: "s1", source });
		git(spike.path, "checkout", "-b", "chopin/spike-s1");
		let spikeEntry = plant(spike.path);
		await discardWorkspace(root, spike.path, "chopin/spike-s1");
		expect(existsSync(spike.path)).toBe(false);
		expect(existsSync(spikeEntry)).toBe(false);
		expect(git(root, "branch", "--list", "chopin/spike-s1")).toBe("");
		await endWorkspace(root, first);
		await Bun.sleep(5);
		let next = await prepareWorkspace(root, state, { id: "p2", source });
		await endWorkspace(root, next);
		expect(await pruneRuns(state, 1)).toEqual(["p1"]);
		expect(existsSync(first.path)).toBe(false);
		expect(existsSync(entry)).toBe(false);
		expect(readdirSync(join(common, "worktrees"))).toEqual(["p2"]);
		// None of it ran a program an agent named.
		expect(readdirSync(ran)).toEqual([]);
		// The control: the same unfinished rebase is live for git that runs it.
		let control = join(state, "control");
		plain(root, "worktree", "add", "--detach", control);
		expect(plain(control, "rebase", "-i", "--root").status).toBe(0);
		expect(plain(control, "rebase", "--continue").status).toBe(0);
		expect(readdirSync(ran)).toEqual(["rebase-exec"]);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("a run's worktree is found by the git directories the connector recorded when it made it, not by the files an agent can write there afterwards: its .git file and its entry's commondir sent elsewhere change nothing the connector's git does, and retention still removes it", async () => {
	let { root, state, source } = await scoreCheckout();
	try {
		let ran = join(state, "ran");
		let evil = join(state, "evil");
		mkdirSync(ran);
		mkdirSync(evil);
		for (let name of ["post-checkout", "reference-transaction", "fsmonitor"]) {
			writeFileSyncNow(join(evil, name), `#!/bin/sh\ntouch '${ran}/${name}'\n`);
			chmodSync(join(evil, name), 0o755);
		}
		let prepared = await prepareWorkspace(root, state, { id: "t1", source });
		expect(JSON.parse(await readFile(prepared.journalPath, "utf8")).root).toBe(root);
		let common = join(root, ".git");
		let entry = join(common, "worktrees", "t1");
		// What an agent that wrote them would leave: a git directory of its own that names programs,
		// and the worktree and its entry sending git there.
		let fake = join(state, "fake");
		cpSync(common, fake, { recursive: true });
		git(fake, "config", "--file", join(fake, "config"), "core.hooksPath", evil);
		git(fake, "config", "--file", join(fake, "config"), "core.fsmonitor", join(evil, "fsmonitor"));
		writeFileSyncNow(join(entry, "commondir"), `${fake}\n`);
		writeFileSyncNow(join(prepared.path, ".git"), `gitdir: ${join(fake, "worktrees", "t1")}\n`);
		// The control: git that finds its directories where the files say is sent there.
		expect(
			spawnSync("git", [
				"-C",
				prepared.path,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			], { encoding: "utf8" }).stdout.trim(),
		).toBe(fake);
		expect(git(prepared.path, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
			common,
		);
		expect(git(prepared.path, "rev-parse", "--path-format=absolute", "--git-dir")).toBe(entry);
		git(prepared.path, "checkout", "-b", "chopin/implement-t1");
		await endWorkspace(root, prepared);
		let next = await prepareWorkspace(root, state, { id: "t2", source });
		await endWorkspace(root, next);
		expect(await pruneRuns(state, 1)).toEqual(["t1"]);
		expect(readdirSync(ran)).toEqual([]);
		expect(existsSync(prepared.path)).toBe(false);
		let listed = git(root, "worktree", "list", "--porcelain").split("\n")
			.filter(line => line.startsWith("worktree "));
		expect(listed).toEqual([`worktree ${root}`, `worktree ${next.path}`]);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("a sandboxed Planner's worktree is made in its checkout's repository before it starts, found again on later launches, made again when its folder is gone, and left alone when something else is there", async () => {
	let { root, state } = await scoreCheckout();
	try {
		let worktree = join(state, "planners", "octo-org", "score", "D_1");
		await mkdir(join(state, "planners", "octo-org", "score"), { recursive: true });
		let listed = () =>
			git(root, "worktree", "list", "--porcelain").split("\n")
				.filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
		expect(await preparePlannerWorktree(root, worktree)).toBe(true);
		expect(listed()).toEqual([root, worktree]);
		expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("base");
		// Work the Planner did there is as it left it on the next launch.
		await writeFile(join(worktree, "notes.txt"), "the Planner's");
		git(worktree, "checkout", "-b", "planner/work");
		expect(await preparePlannerWorktree(root, worktree)).toBe(true);
		expect(listed()).toEqual([root, worktree]);
		expect(await readFile(join(worktree, "notes.txt"), "utf8")).toBe("the Planner's");
		expect(git(worktree, "branch", "--show-current")).toBe("planner/work");
		// Its folder removed by hand: git still lists it, and it is made again.
		await rm(worktree, { recursive: true, force: true });
		expect(await preparePlannerWorktree(root, worktree)).toBe(true);
		expect(listed()).toEqual([root, worktree]);
		expect(existsSync(join(worktree, "file.txt"))).toBe(true);
		// An empty folder, which an earlier launch made for a sandbox, becomes one.
		let empty = join(state, "planners", "octo-org", "score", "D_2");
		await mkdir(empty);
		expect(await preparePlannerWorktree(root, empty)).toBe(true);
		expect(existsSync(join(empty, "file.txt"))).toBe(true);
		// A folder with something else in it is no worktree, and is not touched.
		let other = join(state, "planners", "octo-org", "score", "D_3");
		await mkdir(other);
		await writeFile(join(other, "theirs.txt"), "not a worktree");
		expect(await preparePlannerWorktree(root, other)).toBe(false);
		expect(readdirSync(other)).toEqual(["theirs.txt"]);
		expect(listed()).not.toContain(other);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("a sandboxed Planner's worktree is made on the host without running any filter its checkout's configuration defines, and holds the files as they are committed", async () => {
	let { root, state } = await scoreCheckout();
	try {
		let ran = join(state, "ran");
		await mkdir(ran);
		let program = (name: string, body: string) => {
			let path = join(state, name);
			writeFileSyncNow(path, `#!/bin/sh\n${body}\n`);
			chmodSync(path, 0o755);
			return path;
		};
		await writeFile(join(root, ".gitattributes"), "* filter=mine\nother.txt filter=process\n");
		await writeFile(join(root, "other.txt"), "other");
		git(root, "add", ".");
		git(root, "commit", "-m", "attributes");
		git(root, "config", "filter.mine.smudge", program("smudge", `touch '${ran}/smudge'; cat`));
		git(root, "config", "filter.mine.clean", "cat");
		git(root, "config", "filter.process.process", program("process", `touch '${ran}/process'`));
		// Plain git runs both (and fails at the process, which does not answer), so that nothing
		// having run below means something.
		let control = join(state, "control");
		spawnSync("git", ["-C", root, "worktree", "add", "--detach", control], { stdio: "ignore" });
		expect((await readdir(ran)).sort()).toEqual(["process", "smudge"]);
		for (let name of await readdir(ran)) await rm(join(ran, name));
		let worktree = join(state, "planners", "octo-org", "score", "D_1");
		await mkdir(join(state, "planners", "octo-org", "score"), { recursive: true });
		expect(await preparePlannerWorktree(root, worktree)).toBe(true);
		expect(await readdir(ran)).toEqual([]);
		expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("base");
		expect(await readFile(join(worktree, "other.txt"), "utf8")).toBe("other");
		expect(existsSync(join(worktree, ".gitattributes"))).toBe(true);
		expect(git(worktree, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("replaces a lock left by a connector whose process is gone, and keeps a live one", async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		let root = "/fixture/checkout";
		let release = await lockWorkspace(root, state);
		let [lock] = (await readdir(state)).filter(name => name.endsWith(".lock"));
		let path = join(state, lock);
		await release();

		// A live process, even when it is not this one, still holds the workspace.
		await writeFile(path, JSON.stringify({ pid: process.ppid, root }));
		await expect(lockWorkspace(root, state)).rejects.toThrow("already locked");

		// An exited process's lock is stale.
		let child = Bun.spawn(["true"]);
		await child.exited;
		await writeFile(path, JSON.stringify({ pid: child.pid, root }));
		let replaced = await lockWorkspace(root, state);
		expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
		await replaced();

		// A lock that does not name a process is left for a person to check.
		await writeFile(path, "");
		await expect(lockWorkspace(root, state)).rejects.toThrow("already locked");
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("a lock whose pid now belongs to another process is stale, and can be replaced", async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		let root = "/fixture/reused";
		let release = await lockWorkspace(root, state);
		let lock = (await readdir(state)).find(name => name.endsWith(".lock"));
		let path = join(state, lock!);
		// The lock records when the process holding it started.
		let recorded = JSON.parse(await readFile(path, "utf8")).processStart;
		expect(recorded).toBe((await processStart()(process.pid))!.id);
		expect((await connectors(state)).map(item => item.running)).toEqual([true]);
		await release();

		// The pid is this process's now, but the connector that wrote the lock started at another
		// time: that connector is gone.
		await writeFile(path, JSON.stringify({ pid: process.pid, root, processStart: "1" }));
		expect((await connectors(state)).map(item => item.running)).toEqual([false]);
		let replaced = await lockWorkspace(root, state);
		expect(JSON.parse(await readFile(path, "utf8")).processStart).toBe(recorded);
		await replaced();

		// A lock without a start time is stale once it is older than its pid's process.
		await writeFile(path, JSON.stringify({ pid: process.pid, root, started: 1 }));
		expect((await connectors(state)).map(item => item.running)).toEqual([false]);
		await writeFile(path, JSON.stringify({ pid: process.pid, root, started: Date.now() }));
		expect((await connectors(state)).map(item => item.running)).toEqual([true]);
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("on macOS and Windows a process's start time is read through the runner", async () => {
	let at = Date.UTC(2026, 9, 13, 9, 30, 5);
	let filetime = String((BigInt(at) + 11644473600000n) * 10000n);
	let calls: string[] = [];
	let answer = "";
	let run = async (command: string, args: string[]) => {
		calls.push([command, ...args].join(" "));
		return { code: 0, stdout: answer, stderr: "" };
	};
	answer = "Tue Oct 13 09:30:05 2026\n";
	expect(await processStart("darwin", run)(4242)).toEqual({
		id: "Tue Oct 13 09:30:05 2026",
		at,
	});
	// The same answer whatever the locale or time zone of the process that asks.
	expect(calls.at(-1)).toBe("/usr/bin/env -i LC_ALL=C TZ=UTC /bin/ps -o lstart= -p 4242");
	answer = `${filetime}\r\n`;
	expect(await processStart("win32", run)(4242)).toEqual({ id: filetime, at });
	expect(calls.at(-1)).toContain("powershell.exe -NoProfile -NonInteractive -Command ");
	expect(calls.at(-1)).toContain("Get-Process -Id 4242");
	// No answer, as for a process that is gone, is no start time.
	answer = "";
	expect(await processStart("darwin", run)(4242)).toBeUndefined();
	expect(await processStart("win32", run)(4242)).toBeUndefined();

	// connectors() asks through the same runner: a different start time is a stale lock.
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		let lock = join(state, `${"c".repeat(64)}.lock`);
		await writeFile(
			lock,
			JSON.stringify({ pid: process.pid, root: "/r", processStart: "Mon Oct 12 08:00:00 2026" }),
		);
		answer = "Tue Oct 13 09:30:05 2026\n";
		let probe = processStart("darwin", run);
		expect((await connectors(state, probe)).map(item => item.running)).toEqual([false]);
		answer = "Mon Oct 12 08:00:00 2026\n";
		expect((await connectors(state, probe)).map(item => item.running)).toEqual([true]);
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("lists the connectors running for a state directory, and those whose process is gone", async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		expect(await connectors(join(state, "missing"))).toEqual([]);
		let planners = ["https://chopin.example/d/one"];
		let release = await lockWorkspace("/fixture/served", state, { service: true, planners });
		let child = Bun.spawn(["true"]);
		await child.exited;
		await writeFile(
			join(state, `${"a".repeat(64)}.lock`),
			JSON.stringify({ pid: child.pid, root: "/fixture/crashed" }),
		);
		// machine.json's own lock and a lock still being written are not connectors.
		await writeFile(join(state, "machine.json.lock"), JSON.stringify({ pid: process.pid }));
		await writeFile(join(state, `${"b".repeat(64)}.lock`), "");
		let listed = await connectors(state);
		expect(listed.sort((a, b) => (a.root ?? "").localeCompare(b.root ?? ""))).toEqual([
			{ pid: child.pid, root: "/fixture/crashed", running: false, service: false },
			{
				pid: process.pid,
				root: "/fixture/served",
				running: true,
				service: true,
				planners,
				version: VERSION,
				protocol: CONNECTOR_PROTOCOL,
				started: expect.any(Number),
			},
		]);
		await release();
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("a spike's agent cannot push, and its throwaway worktree and branch are removed", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-spike-root-"));
	let remote = await mkdtemp(join(tmpdir(), "chopin-spike-remote-"));
	let directory = await mkdtemp(join(tmpdir(), "chopin-spike-state-"));
	let git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
	try {
		execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
		git(root, "init", "-b", "main");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
		await writeFile(join(root, "file.txt"), "base");
		git(root, "add", ".");
		git(root, "commit", "-m", "base");
		let commit = git(root, "rev-parse", "HEAD");
		let id = crypto.randomUUID();
		let prepared = await prepareWorkspace(root, directory, {
			id,
			source: { repositoryId: "R_1", repository: "octo-org/score", commit },
		});
		let branch = `chopin/spike-${id.slice(0, 8)}`;
		git(prepared.path, "checkout", "-b", branch);
		// Even a push to a local path is refused under the spike's environment.
		let pushed = spawnSync("git", ["-C", prepared.path, "push", remote, branch], {
			env: { ...process.env, ...noPushEnvironment() },
			encoding: "utf8",
		});
		expect(pushed.status).not.toBe(0);
		expect(git(remote, "branch", "--list", branch)).toBe("");
		await discardWorkspace(root, prepared.path, branch);
		expect(existsSync(prepared.path)).toBe(false);
		expect(git(root, "branch", "--list", branch)).toBe("");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(remote, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test("retention keeps the most recent finished runs, never one running or queued, nor Planner worktrees", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-keep-root-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-keep-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
		await writeFile(join(root, "file.txt"), "base");
		git(root, "add", ".");
		git(root, "commit", "-m", "base");
		let commit = git(root, "rev-parse", "HEAD");
		let source = { repositoryId: "R_1", repository: "octo-org/score", commit };
		let prepare = (id: string) => prepareWorkspace(root, state, { id, source });
		let runs = join(state, "runs");

		// A connector that crashed mid-run left its run unfinished, with an extra worktree in it.
		let crashed = await prepare("crashed");
		git(crashed.path, "worktree", "add", "-b", "chopin/left", join(crashed.extras, "left"));
		await writeFile(join(crashed.extras, "left", "file.txt"), "uncommitted");
		let gone = Bun.spawn(["true"]);
		await gone.exited;
		let journal = JSON.parse(await readFile(crashed.journalPath, "utf8"));
		await writeFile(crashed.journalPath, JSON.stringify({ ...journal, pid: gone.pid }));
		// Its GitHub token, in its folder of tokens, which a run that ended would have deleted.
		await mkdir(join(runs, "crashed.tokens"));
		await writeFile(join(runs, "crashed.tokens", "github"), "ghu_left\n", { mode: 0o600 });
		// What a connector of an earlier release left beside its runs: a token file named for the run,
		// which it removed with the run and this one must too.
		for (
			let name of ["crashed.github-token", "a.github-token", "a.planner-token", "d.github-token"]
		) {
			await writeFile(join(runs, name), "ghu_old\n", { mode: 0o600 });
		}
		// This connector's run in progress, then one it accepted but has yet to start.
		await prepare("running");
		await writeFile(
			join(runs, "queued.json"),
			JSON.stringify({
				id: "queued",
				state: "accepted",
				pid: process.pid,
				processStart: (await processStart()(process.pid))!.id,
			}),
		);
		for (let id of ["a", "b", "c", "d"]) {
			await endWorkspace(root, await prepare(id));
			await Bun.sleep(5);
		}
		let planner = join(state, "planners", "octo-org", "score", "D_1");
		await mkdir(planner, { recursive: true });
		await writeFile(join(planner, "notes.txt"), "the Planner's");

		// 0 keeps every run.
		expect(await pruneRuns(state, 0)).toEqual([]);
		expect((await pruneRuns(state, 2)).sort()).toEqual(["a", "b", "crashed"]);
		expect((await readdir(runs)).sort()).toEqual([
			"c",
			"c.json",
			"d",
			"d.github-token",
			"d.json",
			"queued.json",
			"running",
			"running-worktrees",
			"running.json",
		]);
		let listed = git(root, "worktree", "list", "--porcelain").split("\n")
			.filter(line => line.startsWith("worktree "));
		expect(listed).toHaveLength(4);
		expect(existsSync(join(planner, "notes.txt"))).toBe(true);
		// The oldest kept goes next; the run in progress never does.
		expect(await pruneRuns(state, 1)).toEqual(["c"]);
		// The token files an earlier release left go with their run and only with it: a kept run's stay.
		expect(existsSync(join(runs, "d.github-token"))).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
