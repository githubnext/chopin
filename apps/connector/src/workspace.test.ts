import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	connectors,
	discardWorkspace,
	git,
	lockWorkspace,
	noPushEnvironment,
	prepareWorkspace,
	processStart,
	workspace,
} from "./workspace";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";

test("isolates exact source without stashing dirty work and never executes an accepted run twice", async () => {
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
		await release();
		git(root, "worktree", "remove", prepared.path);
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
		let release = await lockWorkspace("/fixture/served", state, { service: true });
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
		expect(listed.sort((a, b) => a.root.localeCompare(b.root))).toEqual([
			{ pid: child.pid, root: "/fixture/crashed", running: false, service: false },
			{
				pid: process.pid,
				root: "/fixture/served",
				running: true,
				service: true,
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
