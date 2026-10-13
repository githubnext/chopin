import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { RunInput } from "@chopin/experiment";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";

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

/** Where the machine token, locks and worktrees live: `--base-dir`, CHOPIN_HOME, or the default. */
export function stateDirectory() {
	return process.env.CHOPIN_HOME || process.env.CHOPIN_CONNECTOR_STATE_DIR
		|| join(
			process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
			"chopin",
			"connector",
		);
}

/**
 * Hold a checkout for this process. The lock names the process, the checkout and the chopin that
 * holds it, so `chopin status` can list the connectors running for a state directory; `service`
 * marks the one the installed service runs.
 */
export async function lockWorkspace(
	root: string,
	directory: string,
	{ service = false }: { service?: boolean } = {},
) {
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
	await file.writeFile(JSON.stringify({
		pid: process.pid,
		root,
		version: VERSION,
		protocol: CONNECTOR_PROTOCOL,
		started: Date.now(),
		...(service ? { service } : {}),
	}));
	return async () => {
		await file.close();
		await rm(path, { force: true });
	};
}

/** Whether no process `pid` exists; EPERM means it exists but belongs to someone else. */
function gone(pid: number) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Only a lock naming a process that no longer exists is stale; unreadable locks are kept. */
async function staleLock(path: string): Promise<boolean> {
	let pid: unknown;
	try {
		pid = JSON.parse(await readFile(path, "utf8")).pid;
	} catch {
		return false;
	}
	return Number.isSafeInteger(pid) && (pid as number) > 0 && gone(pid as number);
}

/** A connector that holds, or held until it crashed, a checkout's lock in a state directory. */
export type RunningConnector = {
	pid: number;
	root: string;
	/** False when its process is gone and the lock is stale; the next `connect` replaces it. */
	running: boolean;
	/** Whether the installed service runs it. */
	service: boolean;
	/** The chopin version and protocol it runs, absent from a lock written before they were. */
	version?: string;
	protocol?: number;
	started?: number;
};

/** Every checkout lock in `directory`, skipping any that is unreadable or still being written. */
export async function connectors(directory: string): Promise<RunningConnector[]> {
	let names = await readdir(directory).catch(() => [] as string[]);
	let found: RunningConnector[] = [];
	for (let name of names.filter(name => /^[0-9a-f]{64}\.lock$/.test(name))) {
		let held: Record<string, unknown>;
		try {
			held = JSON.parse(await readFile(join(directory, name), "utf8"));
		} catch {
			continue;
		}
		let { pid, root, version, protocol, started } = held;
		if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof root !== "string") continue;
		found.push({
			pid: pid as number,
			root,
			running: !gone(pid as number),
			service: held.service === true,
			...(typeof version === "string" ? { version } : {}),
			...(typeof protocol === "number" ? { protocol } : {}),
			...(typeof started === "number" ? { started } : {}),
		});
	}
	return found;
}

/**
 * Git configuration, through the environment, under which every push from the agent's process
 * tree fails: each remote URL is rewritten to a scheme Git cannot push to. A spike runs under it,
 * so its throwaway branch never leaves the laptop even if the agent tries.
 */
export function noPushEnvironment(): Record<string, string> {
	let prefixes = ["https://", "http://", "ssh://", "git@", "git://", "file://", "/", "."];
	let env: Record<string, string> = { GIT_CONFIG_COUNT: String(prefixes.length) };
	prefixes.forEach((prefix, index) => {
		env[`GIT_CONFIG_KEY_${index}`] = "url.chopin-spike-never-pushes://.pushInsteadOf";
		env[`GIT_CONFIG_VALUE_${index}`] = prefix;
	});
	return env;
}

/** Remove a finished spike's worktree and throwaway branch; its screenshots were uploaded. */
export async function discardWorkspace(root: string, path: string, branch: string) {
	try {
		await promisify(execFile)("git", ["-C", root, "worktree", "remove", "--force", path], {
			timeout: 60_000,
		});
	} catch {
		await rm(path, { recursive: true, force: true });
		await promisify(execFile)("git", ["-C", root, "worktree", "prune"]).catch(() => {});
	}
	await promisify(execFile)("git", ["-C", root, "branch", "-D", branch]).catch(() => {});
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
