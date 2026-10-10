import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { RunInput } from "@chopin/experiment";

export function git(cwd: string, ...args: string[]): string {
	let result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000 });
	if (result.status !== 0) {
		throw new Error(`Git ${args[0]} failed: ${result.stderr || result.error?.message}`);
	}
	return result.stdout.trim();
}

export async function workspace(path: string) {
	let root = await realpath(git(path, "rev-parse", "--show-toplevel"));
	let origin = git(root, "remote", "get-url", "origin");
	let match = origin.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
	if (!match) throw new Error("The checkout must have a github.com origin.");
	return {
		root,
		repository: match[1],
		commit: git(root, "rev-parse", "HEAD"),
		branch: git(root, "branch", "--show-current") || undefined,
	};
}

export function stateDirectory() {
	return process.env.CHOPIN_CONNECTOR_STATE_DIR
		?? join(
			process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
			"chopin",
			"connector",
		);
}

export async function lockWorkspace(root: string, directory: string) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let id = createHash("sha256").update(root).digest("hex");
	let path = join(directory, `${id}.lock`);
	let file;
	try {
		file = await open(path, "wx", 0o600);
	} catch {
		// A connector that crashed leaves its lock behind; replace it once its process is gone.
		if (!await staleLock(path)) {
			throw new Error(
				`Workspace already locked. After confirming no connector is running, remove ${path}`,
			);
		}
		await rm(path, { force: true });
		try {
			file = await open(path, "wx", 0o600);
		} catch {
			throw new Error(`Workspace already locked by a connector that just started. ${path}`);
		}
	}
	await file.writeFile(JSON.stringify({ pid: process.pid, root }));
	return async () => {
		await file.close();
		await rm(path, { force: true });
	};
}

/** Only a lock naming a process that no longer exists is stale; unreadable locks are kept. */
async function staleLock(path: string): Promise<boolean> {
	let pid: unknown;
	try {
		pid = JSON.parse(await readFile(path, "utf8")).pid;
	} catch {
		return false;
	}
	if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
	try {
		process.kill(pid as number, 0);
		return false;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export async function prepareWorkspace(
	root: string,
	directory: string,
	input: Pick<RunInput, "id" | "source">,
) {
	let current = await workspace(root);
	if (current.repository.toLowerCase() !== input.source.repository.toLowerCase()) {
		throw new Error("Repository differs from the authorized run.");
	}
	await mkdir(join(directory, "runs"), { recursive: true, mode: 0o700 });
	let journalPath = join(directory, "runs", `${input.id}.json`);
	let journal;
	try {
		journal = await open(journalPath, "wx", 0o600);
	} catch {
		throw new Error(
			"This run was already accepted locally. Reconcile it instead of executing it again.",
		);
	}
	await journal.writeFile(
		JSON.stringify({ id: input.id, source: input.source, state: "accepted" }),
	);
	await journal.sync();
	await journal.close();
	try {
		git(root, "cat-file", "-e", `${input.source.commit}^{commit}`);
	} catch {
		await promisify(execFile)("git", ["-C", root, "fetch", "origin", input.source.commit], {
			timeout: 120_000,
		});
	}
	let path = join(directory, "runs", input.id);
	await promisify(execFile)("git", [
		"-C",
		root,
		"worktree",
		"add",
		"--detach",
		path,
		input.source.commit,
	], { timeout: 120_000 });
	return { path, journalPath };
}
