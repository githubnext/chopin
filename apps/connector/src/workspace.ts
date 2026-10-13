import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
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

/** When a process started: `id` differs for each process that held a pid, `at` is in ms. */
export type ProcessStart = { id: string; at: number };

/** Reads when process `pid` started; undefined when it can't be read, as when it is gone. */
export type StartProbe = (pid: number) => Promise<ProcessStart | undefined>;

type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const runFile: Run = (command, args) =>
	new Promise(resolve => {
		execFile(command, args, { timeout: 30_000, windowsHide: true }, (error, stdout) => {
			resolve({ code: error ? 1 : 0, stdout: String(stdout) });
		});
	});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Windows FILETIME counts 100 ns from 1601; this many ms lie between 1601 and 1970. */
const FILETIME_EPOCH_MS = 11644473600000n;

/**
 * How this machine reads a process's start: on Linux field 22 of /proc/<pid>/stat, in clock
 * ticks since boot; on macOS `ps -o lstart=` in the C locale and UTC, so the service and a
 * terminal read it the same; on Windows the process's creation time. Commands go through `run`.
 */
export function processStart(
	platform: NodeJS.Platform = process.platform,
	run: Run = runFile,
): StartProbe {
	if (platform === "linux") {
		return async pid => {
			let stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
			// The command name, in parentheses, may hold spaces; field 3 follows its last `)`.
			let ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
			let boot = (await readFile("/proc/stat", "utf8").catch(() => "")).match(/^btime (\d+)$/m);
			if (!ticks || !/^\d+$/.test(ticks)) return undefined;
			// USER_HZ, the tick /proc reports in, is 100 on every Linux architecture.
			let at = boot ? Number(boot[1]) * 1000 + Number(ticks) * 10 : Number.NaN;
			return { id: ticks, at };
		};
	}
	if (platform === "darwin") {
		return async pid => {
			let shown = await run("/usr/bin/env", [
				"-i",
				"LC_ALL=C",
				"TZ=UTC",
				"/bin/ps",
				"-o",
				"lstart=",
				"-p",
				String(pid),
			]);
			let id = shown.code === 0 ? shown.stdout.trim().replaceAll(/\s+/g, " ") : "";
			let part = id.match(/^\w{3} (\w{3}) (\d+) (\d+):(\d+):(\d+) (\d{4})$/);
			if (!part) return undefined;
			let [, month, day, hour, minute, second, year] = part;
			let at = Date.UTC(
				Number(year),
				MONTHS.indexOf(month!),
				Number(day),
				Number(hour),
				Number(minute),
				Number(second),
			);
			return { id, at };
		};
	}
	if (platform === "win32") {
		return async pid => {
			let root = process.env.SystemRoot ?? "C:\\Windows";
			let shown = await run(
				win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch {}`,
				],
			);
			let id = shown.code === 0 ? shown.stdout.trim() : "";
			if (!/^\d+$/.test(id)) return undefined;
			return { id, at: Number(BigInt(id) / 10000n - FILETIME_EPOCH_MS) };
		};
	}
	return async () => undefined;
}

/**
 * Hold a checkout for this process. The lock names the process, when it started, the checkout
 * and the chopin that holds it, so `chopin status` can list the connectors running for a state
 * directory; `service` marks the one the installed service runs, and `planners` names the
 * documents whose Planner backends it runs. The lock holds no credential.
 */
export async function lockWorkspace(
	root: string,
	directory: string,
	{ service = false, planners = [], probe = processStart() }: {
		service?: boolean;
		planners?: string[];
		probe?: StartProbe;
	} = {},
) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let id = createHash("sha256").update(root).digest("hex");
	let path = join(directory, `${id}.lock`);
	let file;
	try {
		file = await open(path, "wx", 0o600);
	} catch {
		// A connector that crashed leaves its lock behind; replace it once its process is gone.
		if (!await staleLock(path, probe)) {
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
	let started = await probe(process.pid);
	await file.writeFile(JSON.stringify({
		pid: process.pid,
		...(started ? { processStart: started.id } : {}),
		root,
		version: VERSION,
		protocol: CONNECTOR_PROTOCOL,
		started: Date.now(),
		...(service ? { service } : {}),
		...(planners.length ? { planners } : {}),
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

/** How far a start time read back may sit after the moment it was read, from rounding. */
const START_SLACK_MS = 2000;

/**
 * Whether the process that wrote a lock still runs: a process has its pid and started when the
 * lock says. A lock without a start time that can be compared is held while its pid exists,
 * unless it was written before the process now holding that pid started.
 */
async function holds(held: Record<string, unknown>, probe: StartProbe) {
	let pid = held.pid as number;
	if (gone(pid)) return false;
	let now = await probe(pid);
	if (!now) return true;
	if (typeof held.processStart === "string") return held.processStart === now.id;
	return !(typeof held.started === "number" && held.started + START_SLACK_MS < now.at);
}

/** Only a lock naming a process that no longer runs is stale; unreadable locks are kept. */
async function staleLock(path: string, probe: StartProbe): Promise<boolean> {
	let held: Record<string, unknown>;
	try {
		held = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return false;
	}
	return Number.isSafeInteger(held?.pid) && (held.pid as number) > 0 && !await holds(held, probe);
}

/** A connector that holds, or held until it crashed, a checkout's lock in a state directory. */
export type RunningConnector = {
	pid: number;
	root: string;
	/**
	 * False when the lock is stale: its process is gone, or its pid now belongs to a process that
	 * started at another time. The next `connect` replaces it.
	 */
	running: boolean;
	/** Whether the installed service runs it. */
	service: boolean;
	/** The documents whose Planner backends it runs, when it runs any. */
	planners?: string[];
	/** The chopin version and protocol it runs, absent from a lock written before they were. */
	version?: string;
	protocol?: number;
	started?: number;
};

/**
 * Every checkout lock in `directory`, skipping any that is unreadable or still being written.
 * `probe` reads when each lock's process started.
 */
export async function connectors(
	directory: string,
	probe: StartProbe = processStart(),
): Promise<RunningConnector[]> {
	let names = await readdir(directory).catch(() => [] as string[]);
	let found: RunningConnector[] = [];
	for (let name of names.filter(name => /^[0-9a-f]{64}\.lock$/.test(name))) {
		let held: Record<string, unknown>;
		try {
			held = JSON.parse(await readFile(join(directory, name), "utf8"));
		} catch {
			continue;
		}
		let { pid, root, version, protocol, started, planners } = held;
		if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof root !== "string") continue;
		found.push({
			pid: pid as number,
			root,
			running: await holds(held, probe),
			service: held.service === true,
			...(Array.isArray(planners) && planners.length
					&& planners.every(document => typeof document === "string")
				? { planners: planners as string[] }
				: {}),
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
