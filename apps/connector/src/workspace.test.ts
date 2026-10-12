import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	discardWorkspace,
	git,
	lockWorkspace,
	noPushEnvironment,
	prepareWorkspace,
	workspace,
} from "./workspace";

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
