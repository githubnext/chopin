import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep, win32 } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { RunInput } from "@chopin/experiment";
import { redacted } from "./connection";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";

export function git(cwd: string, ...args: string[]): string {
	let result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000 });
	if (result.status !== 0) {
		throw new Error(`Git ${args[0]} failed: ${result.stderr || result.error?.message}`);
	}
	return result.stdout.trim();
}

/**
 * The checkout at `path`: its root, GitHub repository, commit and branch. What stops it says what
 * to do, since `chopin connect` is often the first thing run in a new folder.
 */
export async function workspace(path: string) {
	let again = "then run this command again.";
	let top: string;
	try {
		top = git(path, "rev-parse", "--show-toplevel");
	} catch (error) {
		if (!Bun.which("git", { PATH: process.env.PATH ?? "" })) {
			throw new Error(
				`git isn't installed, so nothing was paired or connected. Install git, ${again}`,
				{ cause: error },
			);
		}
		throw new Error(
			`${path} isn't inside a git checkout, so nothing was paired or connected. cd into your `
				+ `repository's folder (a clone from GitHub), ${again}`,
			{ cause: error },
		);
	}
	let root = await realpath(top);
	let origin = "";
	try {
		origin = git(root, "remote", "get-url", "origin");
	} catch { /* Said below, as for an origin elsewhere. */ }
	let match = origin.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
	if (!match) {
		throw new Error(
			`${root}'s origin ${origin ? `(${redacted(origin)}) ` : ""}isn't a github.com repository, `
				+ "so Chopin can't connect it. Check it with `git remote -v`; Chopin connects clones of "
				+ "GitHub repositories.",
		);
	}
	let commit: string;
	try {
		commit = git(root, "rev-parse", "HEAD");
	} catch {
		throw new Error(`${root} has no commits yet. Commit once with \`git commit\`, ${again}`);
	}
	return {
		root,
		repository: match[1]!,
		commit,
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

/** A path segment made only of characters safe in any file system, never `.` or `..`. */
function segment(value: string) {
	let safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
	return /^\.*$/.test(safe) ? `_${safe}` : safe;
}

/**
 * Where a document's Planner command keeps its own git worktree of the checkout:
 * `<base>/planners/<owner>/<repo>/<document id>`, by the checkout's GitHub repository, so a
 * Planner started again finds it there. The folders above it are made private (0700); the
 * worktree itself is the Planner's to make, and nothing here ever removes it.
 */
export async function plannerWorktree(directory: string, repository: string, document: string) {
	let [owner = "", name = ""] = repository.toLowerCase().split("/");
	let parent = join(directory, "planners", segment(owner), segment(name));
	// Never fatal here: a Planner that can't make its worktree says why itself.
	await mkdir(parent, { recursive: true, mode: 0o700 }).catch(() => {});
	return join(parent, segment(document));
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
 * directory; `service` marks the one the installed service runs, `planners` names the
 * documents whose Planner backends it runs, and `plannerCommand` says it has a Planner command, so
 * it can run the Planner of a document that chooses this machine. The lock holds no credential.
 */
export async function lockWorkspace(
	root: string,
	directory: string,
	{ service = false, planners = [], plannerCommand = false, probe = processStart() }: {
		service?: boolean;
		planners?: string[];
		plannerCommand?: boolean;
		probe?: StartProbe;
	} = {},
) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let path = join(directory, `${lockId(root)}.lock`);
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
		...(plannerCommand ? { plannerCommand } : {}),
	}));
	return async () => {
		await file.close();
		await rm(path, { force: true });
		await rm(path.replace(/\.lock$/, ".failures.json"), { force: true });
		await rm(path.replace(/\.lock$/, ".chosen.json"), { force: true });
		await rm(path.replace(/\.lock$/, ".github.json"), { force: true });
	};
}

function lockId(root: string) {
	return createHash("sha256").update(root).digest("hex");
}

/**
 * How the agent or a document's Planner backend last failed to start or exited early: how it
 * ended, the first line of its stderr, when, and when the Planner backend is started again.
 * A Planner that Chopin refused for good is `stopped`, with the refusal as `how`, and is not
 * started again. Times are in ms.
 */
export type StartFailure = {
	kind: "agent" | "planner";
	document?: string;
	how: string;
	stderr?: string;
	stopped?: true;
	at: number;
	retryAt?: number;
};

/**
 * The latest start failure of a connector's agent and of each of its Planner backends, kept for
 * `chopin status` in a file beside the checkout's lock, without credentials: token-shaped
 * strings and the `secrets` each failure names, such as --env values, are masked. A successful
 * start clears its own.
 */
export function startFailures(directory: string, root: string) {
	let path = join(directory, `${lockId(root)}.failures.json`);
	let current = new Map<string, StartFailure>();
	// A connector that crashed may have left its failures behind.
	let writing = rm(path, { force: true }).catch(() => {});
	let save = () =>
		writing = writing.then(() =>
			current.size
				? writeFile(path, JSON.stringify([...current.values()]), { mode: 0o600 })
				: rm(path, { force: true })
		).catch(() => {});
	return {
		failed(failure: StartFailure, secrets: string[] = []) {
			current.set(failure.document ?? "", {
				...failure,
				how: redacted(failure.how, secrets).slice(0, 200),
				...(failure.stderr ? { stderr: redacted(failure.stderr, secrets).slice(0, 200) } : {}),
			});
			return save();
		},
		started(document?: string) {
			return current.delete(document ?? "") ? save() : writing;
		},
	};
}

export type StartFailures = ReturnType<typeof startFailures>;

/**
 * The documents whose Planners a connector runs because they chose this machine in Chopin, by URL,
 * kept for `chopin status` in a file beside the checkout's lock. `record` replaces the list.
 */
export function chosenPlanners(directory: string, root: string) {
	let path = join(directory, `${lockId(root)}.chosen.json`);
	// A connector that crashed may have left its list behind.
	let writing = rm(path, { force: true }).catch(() => {});
	return {
		record(documents: string[]) {
			writing = writing.then(() =>
				documents.length
					? writeFile(path, JSON.stringify(documents), { mode: 0o600 })
					: rm(path, { force: true })
			).catch(() => {});
			return writing;
		},
	};
}

export type ChosenPlanners = ReturnType<typeof chosenPlanners>;

/**
 * The checkout's repository once Chopin said its GitHub App can't push there, so the machine's
 * processes use its own GitHub login for it, kept for `chopin status` in a file beside the
 * checkout's lock. `record` is true only the first time, so the connector says it once.
 */
export function githubFallback(directory: string, root: string) {
	let path = join(directory, `${lockId(root)}.github.json`);
	// A connector that crashed may have left its note behind.
	let writing = rm(path, { force: true }).catch(() => {});
	let recorded = false;
	return {
		record(repository: string) {
			if (recorded) return false;
			recorded = true;
			writing = writing.then(() => writeFile(path, JSON.stringify({ repository }), { mode: 0o600 }))
				.catch(() => {});
			return true;
		},
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
	/** It has a Planner command, so it can run the Planner of a document that chooses this machine. */
	plannerCommand?: boolean;
	/** The documents whose Planners it runs because they chose this machine in Chopin, by URL. */
	chosen?: string[];
	/** The chopin version and protocol it runs, absent from a lock written before they were. */
	version?: string;
	protocol?: number;
	started?: number;
	/** How its agent or Planner backends last failed to start, while it runs. */
	failures?: StartFailure[];
	/** The repository its GitHub App can't push to, so its machine uses its own login there. */
	githubCannotPush?: string;
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
		let running = await holds(held, probe);
		let failures = running
			? await readFile(join(directory, name.replace(/\.lock$/, ".failures.json")), "utf8")
				.then(text => JSON.parse(text) as StartFailure[])
				.catch(() => undefined)
			: undefined;
		let chosen: unknown = running
			? await readFile(join(directory, name.replace(/\.lock$/, ".chosen.json")), "utf8")
				.then(text => JSON.parse(text))
				.catch(() => undefined)
			: undefined;
		let github: unknown = running
			? await readFile(join(directory, name.replace(/\.lock$/, ".github.json")), "utf8")
				.then(text => (JSON.parse(text) as { repository?: unknown }).repository)
				.catch(() => undefined)
			: undefined;
		found.push({
			pid: pid as number,
			root,
			running,
			service: held.service === true,
			...(Array.isArray(planners) && planners.length
					&& planners.every(document => typeof document === "string")
				? { planners: planners as string[] }
				: {}),
			...(held.plannerCommand === true ? { plannerCommand: true } : {}),
			...(Array.isArray(chosen) && chosen.length
					&& chosen.every(document => typeof document === "string")
				? { chosen: chosen as string[] }
				: {}),
			...(typeof version === "string" ? { version } : {}),
			...(typeof protocol === "number" ? { protocol } : {}),
			...(typeof started === "number" ? { started } : {}),
			...(Array.isArray(failures) && failures.length ? { failures } : {}),
			...(typeof github === "string" ? { githubCannotPush: github } : {}),
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

/**
 * Accept a run: write its journal in `<base>/runs`, then add its detached worktree there. The
 * journal names this process, so retention never removes a run still going, and `extras`, the
 * folder beside the worktree where its agent may add extra worktrees, which end with the run.
 */
export async function prepareWorkspace(
	root: string,
	directory: string,
	input: Pick<RunInput, "id" | "source">,
	generation = 1,
	probe: StartProbe = processStart(),
) {
	let current = await workspace(root);
	if (current.repository.toLowerCase() !== input.source.repository.toLowerCase()) {
		throw new Error("Repository differs from the authorized run.");
	}
	await mkdir(join(directory, "runs"), { recursive: true, mode: 0o700 });
	// Retry keeps the investigation ID but claims a new generation. Keep earlier work intact.
	let attempt = generation === 1 ? input.id : `${input.id}-${generation}`;
	let journalPath = join(directory, "runs", `${attempt}.json`);
	let journal;
	try {
		journal = await open(journalPath, "wx", 0o600);
	} catch {
		throw new Error(
			"This run was already accepted locally. Reconcile it instead of executing it again.",
		);
	}
	let started = await probe(process.pid);
	await journal.writeFile(
		JSON.stringify({
			id: input.id,
			generation,
			source: input.source,
			state: "accepted",
			pid: process.pid,
			...(started ? { processStart: started.id } : {}),
			accepted: Date.now(),
		}),
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
	let path = join(directory, "runs", attempt);
	await promisify(execFile)("git", [
		"-C",
		root,
		"worktree",
		"add",
		"--detach",
		path,
		input.source.commit,
	], { timeout: 120_000 });
	let extras = extraWorktrees(path);
	await mkdir(extras, { recursive: true, mode: 0o700 });
	return { path, journalPath, extras };
}

/** The folder for a run's extra worktrees, beside the run's own: `<base>/runs/<run>-worktrees`. */
function extraWorktrees(path: string) {
	return `${path}-worktrees`;
}

/**
 * End a run's workspace: remove the extra worktrees its agent added (see `removeWorktreesIn`) and
 * mark its journal finished, which retention orders kept runs by. The run's own worktree stays
 * for inspection.
 */
export async function endWorkspace(
	root: string,
	prepared: { extras: string; journalPath: string },
) {
	await removeWorktreesIn(["-C", root], prepared.extras);
	try {
		let journal = JSON.parse(await readFile(prepared.journalPath, "utf8"));
		await writeFile(
			prepared.journalPath,
			JSON.stringify({ ...journal, state: "finished", finished: Date.now() }),
			{ mode: 0o600 },
		);
	} catch { /* A journal retention already removed has nothing left to mark. */ }
}

const exec = promisify(execFile);

/**
 * Remove every worktree inside `folder` of the repository `repository` names (Git's `-C <dir>` or
 * `--git-dir <dir>`), uncommitted changes included, as their pull requests were pushed; then the
 * folder, and prune what Git still lists. Their branches stay.
 */
async function removeWorktreesIn(repository: string[], folder: string) {
	let inside = await realpath(folder).catch(() => undefined);
	if (inside) {
		let listed = await exec("git", [...repository, "worktree", "list", "--porcelain"])
			.then(({ stdout }) => String(stdout))
			.catch(() => "");
		for (let line of listed.split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			let path = line.slice("worktree ".length);
			let real = await realpath(path).catch(() => path);
			if (!real.startsWith(inside + sep)) continue;
			// Twice --force removes a locked worktree too.
			await exec("git", [...repository, "worktree", "remove", "--force", "--force", path], {
				timeout: 60_000,
			}).catch(() => {});
		}
	}
	await rm(folder, { recursive: true, force: true });
	await exec("git", [...repository, "worktree", "prune"]).catch(() => {});
}

/** The repository a run's worktree belongs to, as `--git-dir <dir>`; undefined when it has none. */
async function worktreeRepository(path: string) {
	// Only a linked worktree has a .git file; a plain folder would name whatever repository holds it.
	let link = await readFile(join(path, ".git"), "utf8").catch(() => "");
	if (!link.startsWith("gitdir:")) return undefined;
	let common = await exec("git", ["-C", path, "rev-parse", "--git-common-dir"])
		.then(({ stdout }) => resolve(path, String(stdout).trim()))
		.catch(() => undefined);
	return common ? ["--git-dir", common] : undefined;
}

/**
 * The runs in `<base>/runs`, by their journals: whether each is `active`, still going or queued
 * because the process its journal names still runs, when it ended (or, for one whose process is
 * gone, was accepted), and whether its worktree is still there. A journal still being written is
 * left out.
 */
export async function runs(directory: string, probe: StartProbe = processStart()) {
	let folder = join(directory, "runs");
	let found: Array<{ attempt: string; active: boolean; at: number; worktree: boolean }> = [];
	for (let name of await readdir(folder).catch(() => [] as string[])) {
		if (!name.endsWith(".json")) continue;
		let file = join(folder, name);
		let journal: Record<string, unknown>;
		try {
			journal = JSON.parse(await readFile(file, "utf8"));
		} catch {
			continue;
		}
		let active = journal.state !== "finished" && Number.isSafeInteger(journal.pid)
			&& (journal.pid as number) > 0 && await holds(journal, probe);
		let at = [journal.finished, journal.accepted].find(value => typeof value === "number")
			?? (await stat(file).catch(() => undefined))?.mtimeMs ?? 0;
		let attempt = name.slice(0, -".json".length);
		found.push({ attempt, active, at: at as number, worktree: existsSync(join(folder, attempt)) });
	}
	return found;
}

/**
 * Keep the `keep` most recently finished runs in `<base>/runs` that still have a worktree, and
 * remove every run that finished before them: its extra worktrees, its worktree (uncommitted
 * changes included), then its journal, pruning Git's list of worktrees. 0 keeps every run. A run
 * still going or queued (see `runs`) is never removed. Planner worktrees, in `<base>/planners`,
 * are never touched. Resolves with the runs it removed.
 */
export async function pruneRuns(
	directory: string,
	keep: number,
	probe: StartProbe = processStart(),
): Promise<string[]> {
	if (keep <= 0) return [];
	let folder = join(directory, "runs");
	let ended = (await runs(directory, probe)).filter(run => !run.active);
	ended.sort((a, b) => b.at - a.at);
	let kept = 0;
	let removed: string[] = [];
	for (let entry of ended) {
		if (kept < keep) {
			if (entry.worktree) kept++;
			continue;
		}
		let path = join(folder, entry.attempt);
		let extras = extraWorktrees(path);
		let repository = await worktreeRepository(path);
		if (repository) {
			await removeWorktreesIn(repository, extras);
			await exec("git", [...repository, "worktree", "remove", "--force", "--force", path], {
				timeout: 60_000,
			}).catch(() => {});
		}
		await rm(extras, { recursive: true, force: true });
		await rm(path, { recursive: true, force: true });
		if (repository) await exec("git", [...repository, "worktree", "prune"]).catch(() => {});
		await rm(join(folder, `${entry.attempt}.github-token`), { force: true });
		await rm(join(folder, `${entry.attempt}.json`), { force: true });
		removed.push(entry.attempt);
	}
	return removed;
}

/**
 * The Planner worktrees in `<base>/planners/<owner>/<repo>/<document id>`: each folder a Planner
 * command made there.
 */
export async function plannerWorktrees(directory: string) {
	let found: Array<{ path: string; repository: string; document: string }> = [];
	let folders = async (path: string) =>
		(await readdir(path, { withFileTypes: true }).catch(() => []))
			.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
	let base = join(directory, "planners");
	for (let owner of await folders(base)) {
		for (let name of await folders(join(base, owner))) {
			for (let document of await folders(join(base, owner, name))) {
				found.push({
					path: join(base, owner, name, document),
					repository: `${owner}/${name}`,
					document,
				});
			}
		}
	}
	return found;
}

/** The disk space `paths` take, in bytes, by `du`; undefined on Windows or when `du` fails. */
export async function diskUsage(paths: string[]): Promise<number | undefined> {
	if (!paths.length) return 0;
	if (process.platform === "win32") return undefined;
	try {
		let { stdout } = await exec("du", ["-sk", ...paths], { timeout: 5_000 });
		return String(stdout).split("\n").filter(Boolean)
			.reduce((total, line) => total + Number(line.split(/\s/)[0]) * 1024, 0);
	} catch {
		return undefined;
	}
}
