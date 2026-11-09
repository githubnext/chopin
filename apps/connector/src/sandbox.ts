import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { arch, homedir, release, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { SandboxReport } from "@chopin/protocol/connector";
import { removePlantedRedirects, worktreeEntry } from "./git-directories";
import { type Repository, repositoryAt } from "./git-host";
import { type Host, probeSandbox } from "./sandbox-probe";
import {
	agentStateDirectories,
	allowedHosts,
	CLONES,
	type Disk,
	inside,
	mxcRequest,
	type Policy,
	readableRoots,
	readGrantsAround,
	type SandboxEngine,
	sandboxPath,
	type SandboxSettings,
	secretPaths,
	windowsReadRoots,
} from "./sandbox-policy";
import { type Proxy, startProxy } from "./sandbox-proxy";

/** What one agent or Planner process is started with, and what it may touch. */
export type Launch = {
	command: string[];
	cwd: string;
	/** The whole environment the process gets. */
	env: NodeJS.ProcessEnv;
	/** Whether it has a stdin to write to; its stdout and stderr are always pipes. */
	stdin: "pipe" | "ignore";
	/**
	 * Directories it may write beside its working directory, such as a Planner's own worktree,
	 * which are made empty where they aren't there yet: a sandbox can't be given a path that does
	 * not exist.
	 */
	writable?: string[];
	/**
	 * Its own paths in the connector's state directory: its worktree and the folder of its tokens,
	 * each by name. It reads them, and writes the ones that are also writable. Nothing else in the
	 * state directory is in its sight, however it came to be there, and the folder of a token must
	 * hold only that launch's, as a token is renewed by replacing its file. A worktree among them
	 * is one the connector made for this launch, so it is written, and its entry in the repository's
	 * git directory with it; a working directory that is not among them, a Planner's checkout, is the
	 * person's own and is read, whole, whatever is in it: its files, its submodules and its git
	 * directory, but for where commits go (see `gitAccess`).
	 */
	own?: string[];
};

/** A started process: its stdout and stderr are always pipes. */
export type Spawned = ChildProcess & { stdout: Readable; stderr: Readable };

/** Where agents are started: through the machine's process sandbox, or plainly. */
export type Sandbox = {
	report: SandboxReport;
	/** Start `launch` in the sandbox. Throws a `SandboxRefused` when the owner requires one and there is none. */
	spawn(launch: Launch): Spawned;
	close(): Promise<void>;
};

/** A run the owner asked chopin not to start without the sandbox. */
export class SandboxRefused extends Error {
	override name = "SandboxRefused";
}

/** Start a process as the operating system would, in its own process group. */
export function plainSpawn(launch: Launch): Spawned {
	return spawn(launch.command[0]!, launch.command.slice(1), {
		cwd: launch.cwd,
		env: launch.env,
		stdio: [launch.stdin, "pipe", "pipe"],
		detached: process.platform !== "win32",
	}) as Spawned;
}

/**
 * Start `launch` through `sandbox`, or as it started before there was one. A process with no
 * sandbox to start it in is what the tests and the `chopin` scripts of earlier releases do.
 */
export function spawnIn(sandbox: Sandbox | undefined, launch: Launch): Spawned {
	return sandbox ? sandbox.spawn(launch) : plainSpawn(launch);
}

/** The words that start MXC's executor on each system, as the SDK names its files. */
const EXECUTOR = { linux: "lxc-exec", darwin: "mxc-exec-mac", win32: "wxc-exec.exe" } as const;
/** The executor's companions on Windows, which must sit beside it. */
const COMPANIONS = ["winhttp-proxy-shim.exe"];

/** Prefix of the files `build-binaries.ts` embeds into the chopin binary. */
export const EMBEDDED_PREFIX = "mxc-";

/**
 * The MXC SDK package nearest above `from`, looked for in each node_modules on the way up. It is
 * never resolved through Bun's own resolver, which installs a package it can't find from npm.
 */
export function sdkRoot(from: string): string | undefined {
	for (let directory = from;; directory = dirname(directory)) {
		let candidate = join(directory, "node_modules", "@microsoft", "mxc-sdk");
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(directory) === directory) return undefined;
	}
}

function sdkBin(platform: NodeJS.Platform, architecture: string): string | undefined {
	let root = sdkRoot(import.meta.dir);
	if (!root || !(platform in EXECUTOR)) return undefined;
	let folder = join(root, "bin", architecture === "arm64" ? "arm64" : "x64");
	return existsSync(folder) ? folder : undefined;
}

/**
 * MXC's executor for this system: the one the chopin binary carries, written under
 * `<base>/sandbox/<hash>` on first use, or, in a source checkout, the one in the SDK package.
 * Undefined where this chopin has none, as for the downloaded script.
 */
export async function locateExecutor(
	directory: string,
	platform: NodeJS.Platform = process.platform,
	architecture: string = arch(),
): Promise<string | undefined> {
	if (!(platform in EXECUTOR)) return undefined;
	let name = EXECUTOR[platform as keyof typeof EXECUTOR];
	if (Bun.isStandaloneExecutable) {
		let files = Bun.embeddedFiles as Array<Blob & { name: string }>;
		let main = files.find(file => file.name.startsWith(`${EMBEDDED_PREFIX}executor-`));
		if (!main) return undefined;
		let bytes = new Uint8Array(await main.arrayBuffer());
		let hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
		let folder = join(directory, "sandbox", hash);
		let target = join(folder, name);
		if (!existsSync(target) || statSync(target).size !== bytes.length) {
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			writeFileSync(target, bytes, { mode: 0o755 });
			chmodSync(target, 0o755);
			for (let companion of COMPANIONS) {
				let stem = companion.replace(/\.exe$/, "");
				let file = files.find(item => item.name.startsWith(`${EMBEDDED_PREFIX}${stem}-`));
				if (file) writeFileSync(join(folder, companion), new Uint8Array(await file.arrayBuffer()));
			}
		}
		return target;
	}
	let folder = sdkBin(platform, architecture);
	let target = folder && join(folder, name);
	return target && existsSync(target) ? target : undefined;
}

/** Find `program` as MXC does: on PATH, then in the system directories. */
function findProgram(program: string, env: NodeJS.ProcessEnv): string | undefined {
	let directories = [
		...(env.PATH ?? "").split(delimiter).filter(entry => entry.startsWith("/")),
		"/usr/local/sbin",
		"/usr/local/bin",
		"/usr/sbin",
		"/usr/bin",
		"/sbin",
		"/bin",
	];
	for (let directory of directories) {
		let path = join(directory, program);
		try {
			if (statSync(path).isFile()) return realpathSync(path);
		} catch { /* Not in this directory. */ }
	}
	return undefined;
}

/** The machine the connector runs on, as the probe asks about it. */
export function systemHost(env: NodeJS.ProcessEnv = process.env): Host {
	return {
		platform: process.platform,
		arch: arch(),
		release: release(),
		env,
		read(path) {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		exists: existsSync,
		find: program => findProgram(program, env),
		async run(executor, request) {
			let folder = mkdtempSync(join(tmpdir(), "chopin-probe-"));
			let file = join(folder, "request.json");
			try {
				writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
				let child = spawn(executor, ["--config", file], {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				let output = "";
				child.stdout.on("data", chunk => output += chunk);
				child.stderr.on("data", chunk => output += chunk);
				let timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
				let code = await new Promise<number | null>(done => {
					child.once("error", error => {
						output += error.message;
						done(null);
					});
					child.once("close", done);
				});
				clearTimeout(timer);
				return { code, output };
			} finally {
				rmSync(folder, { recursive: true, force: true });
			}
		},
	};
}

export type SandboxOptions = {
	/** The connector's state directory. */
	directory: string;
	/** Chopin's origin, which every run may reach. */
	server: string;
	settings?: SandboxSettings;
	/** Hears each host the proxy refuses, once. */
	refused?: (host: string, port: number) => void;
	/** Hears the `commondir` files an earlier agent left in a checkout's git directory, which were removed. */
	planted?: (files: string[]) => void;
	host?: Host;
	executor?: string | undefined;
	/** The person's home directory, whose credentials stay out of sight; this account's by default. */
	home?: string;
};

/** The sandbox that doesn't confine: where none works or the owner turned it off. */
function unconfined(report: SandboxReport, refusal?: string): Sandbox {
	return {
		report,
		spawn(launch) {
			if (refusal) throw new SandboxRefused(refusal);
			return plainSpawn(launch);
		},
		close: async () => {},
	};
}

/** What the probe finds, without starting anything that stays: the report and MXC's executor. */
export async function inspectSandbox(options: {
	directory: string;
	settings?: SandboxSettings | undefined;
	host?: Host;
	executor?: string | undefined;
}): Promise<{ report: SandboxReport; executor?: string | undefined }> {
	let host = options.host ?? systemHost();
	if (options.settings?.off) {
		return { report: { engine: "none", reason: "It is turned off with --no-sandbox." } };
	}
	try {
		let executor = "executor" in options
			? options.executor
			: await locateExecutor(options.directory, host.platform, host.arch);
		return { report: await probeSandbox(host, executor, "http://127.0.0.1:9"), executor };
	} catch (error) {
		let reason = error instanceof Error ? error.message : String(error);
		return {
			report: { engine: "none", reason: `The sandbox check failed: ${reason}`.slice(0, 300) },
		};
	}
}

/**
 * The sandbox this machine can give: probed once, here, by launching a command that does nothing
 * in it. Where none works, runs go on unsandboxed and the report says why; with `require` they
 * are refused instead.
 */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
	let settings = options.settings ?? {};
	let host = options.host ?? systemHost();
	let { report, executor } = await inspectSandbox({
		directory: options.directory,
		settings,
		host,
		...("executor" in options ? { executor: options.executor } : {}),
	});
	if (report.engine === "none" || !executor) {
		let refusal = settings.require
			? `Not run: the sandbox is required (--require-sandbox) and ${
				report.engine === "none" ? report.reason : "there is none"
			}`
			: undefined;
		return unconfined(report, refusal);
	}
	let engine = report.engine;
	let proxy: Proxy = await startProxy({
		hosts: allowedHosts(options.server, settings.hosts),
		refused: (name, port) => options.refused?.(name, port),
	});
	return {
		report,
		spawn: launch => spawnConfined(executor, engine, host, proxy, options, launch),
		close: () => proxy.close(),
	};
}

function exists(path: string) {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

/** A directory this user can read, which MXC refuses to grant otherwise. */
function readableDirectory(path: string) {
	try {
		accessSync(path, constants.R_OK | constants.X_OK);
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function real(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The directory or file this user can read at `path`, by its real path; not a socket or a device. */
function readableAt(path: string) {
	try {
		let resolved = realpathSync(path);
		let directory = statSync(resolved).isDirectory();
		if (!directory && !statSync(resolved).isFile()) return undefined;
		accessSync(resolved, directory ? constants.R_OK | constants.X_OK : constants.R_OK);
		return resolved;
	} catch {
		return undefined;
	}
}

const disk: Disk = {
	list(directory) {
		try {
			return readdirSync(directory);
		} catch {
			return [];
		}
	},
	resolve: readableAt,
};

/** What a launch may write in the repository's git directory: where its commits, refs and LFS objects go. */
const GIT_WRITES = ["objects", "refs", "logs", "lfs"];

/**
 * The directories of the repository's git directory that are read-only there, and are in a launch's
 * own worktree entry too: made empty where there is none, and held. Git doesn't read hooks or
 * what `info` says of attributes from an entry, so they are not a place for them, and a
 * worktree's `modules` holds git directories of submodules, each with a configuration of its own.
 */
const ENTRY_HELD = ["hooks", "info", "modules"];

/**
 * What a launch may write of its repository's git directory, as an allow-list. It writes a
 * working tree only where the connector made it for the launch (`own`: a run's worktree, a
 * Planner's worktree from `preparePlannerWorktree`), and for each such linked worktree it writes
 * that worktree's own entry in `worktrees`, where its HEAD, index, fetch results and the locks
 * beside them are, with the three files git reads there to find configuration, and the three
 * directories the repository's git directory holds read-only too (`ENTRY_HELD`), held read-only
 * inside it, and `objects`, `refs`, `logs` and `lfs` of the repository's git directory, where
 * its commits, branches, fetched objects and LFS objects go. Everything else is read-only, and
 * the directories that hold it can't be renamed or made again, because they are mounted: the
 * repository's `config`, `hooks`, `info`, `HEAD`, `packed-refs` and the git directories of its
 * submodules, `worktrees` itself and every worktree's but the launch's own, and any file git adds
 * to the top level later, such as a `commondir`. A sandbox can only hold back a path that exists,
 * and a new name can't be refused one by one, so the top level is not granted at all. The one
 * place that has to be is the launch's own entry: git takes the lock of its `HEAD` and its index
 * by creating a file beside each and renaming it over them, which a sandbox can't grant for these
 * names and refuse for the others (measured: with the entry read-only and `HEAD`, `index` and `logs`
 * granted as paths, `git add` and `git commit` say `Unable to create 'index.lock': Read-only file
 * system`), so a name made at the top of the entry is made. Git reads nothing there as a hook or a
 * program, and what it reads as a pointer or as configuration is held. A launch with no worktree
 * of its own writes none of it. What it costs is in `docs/chopin-cli.md`.
 *
 * A working directory that is not among `own` is the person's: a Planner's checkout, a regular
 * one or a linked worktree of theirs. It is read-only whole, in `launchPolicy`, so what the
 * person's own git reads and runs there is not the agent's to write: its files, its submodules'
 * (a `.git` file in one sends git to the directory it names), its `.git`, its `HEAD`, its `index`
 * and an unfinished rebase's `exec` lines. Where the entry of an own worktree is is read from the
 * repository's side: the entry whose `gitdir` file names the folder (see `worktreeEntry`), never
 * the `.git` file in a folder an agent writes. That file, which says where a worktree's entry is,
 * is read-only too. An entry's `config.worktree` is made empty where there is none, which git
 * ignores unless `extensions.worktreeConfig` is on, so an agent can't be the one to make it, and
 * so are its `hooks`, `info` and `modules`; an entry that can't be held this way is not granted.
 */
function gitAccess(
	repository: Repository,
	launch: Pick<Launch, "cwd" | "writable" | "own">,
): { writable: string[]; readonlyInside: string[] } {
	let { commonDir } = repository;
	let writable: string[] = [];
	// The repository's git directory is read-only whole, inside whatever the launch may write.
	let readonlyInside: string[] = [commonDir];
	let owned = new Set((launch.own ?? []).map(real));
	let granted = false;
	for (let place of writtenPlaces(launch)) {
		let entry = owned.has(real(place)) ? worktreeEntry(commonDir, place) : undefined;
		// A launch in a linked worktree of its own is in the one the connector recorded, and no other.
		if (entry && place === launch.cwd && real(entry) !== real(repository.gitDir)) entry = undefined;
		if (entry) {
			try {
				writeFileSync(join(entry, "config.worktree"), "", { flag: "wx" });
			} catch { /* There is one, or it can't be made. */ }
			for (let name of ENTRY_HELD) {
				try {
					mkdirSync(join(entry, name));
				} catch { /* There is one, or it can't be made. */ }
			}
			let held = ["commondir", "gitdir", "config.worktree", ...ENTRY_HELD].map(name =>
				join(entry, name)
			);
			if (held.every(file => exists(file))) {
				writable.push(entry);
				readonlyInside.push(...held);
				granted = true;
			}
		}
		// A linked worktree's `.git` is a file that says where its entry is.
		try {
			if (lstatSync(join(place, ".git")).isFile()) readonlyInside.push(join(place, ".git"));
		} catch { /* No `.git` here. */ }
	}
	// Commits, branches and objects go to the repository's git directory from a worktree of its own.
	if (granted) writable.push(...GIT_WRITES.map(name => join(commonDir, name)));
	return { writable, readonlyInside: [...new Set(readonlyInside)] };
}

/**
 * The places a launch writes: the folders it was given beside its working directory, and the
 * working directory itself where the connector made it for the launch (`own`). Any other working
 * directory is the person's, which no sandboxed agent writes.
 */
function writtenPlaces(launch: Pick<Launch, "cwd" | "writable" | "own">) {
	let owned = new Set((launch.own ?? []).map(real));
	return [
		...owned.has(real(launch.cwd)) ? [launch.cwd] : [],
		...launch.writable ?? [],
	];
}

/** The policy for one launch, from what is on the disk now. */
export function launchPolicy(
	engine: SandboxEngine,
	host: Host,
	launch: Launch,
	options: Pick<SandboxOptions, "directory" | "settings" | "home">,
	proxy: string,
	temporary: string,
): Policy {
	let { platform } = host;
	let home = options.home ?? homedir();
	let state = agentStateDirectories(launch.command, launch.env, home, platform);
	for (let directory of state) {
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
		} catch { /* The agent says so if it needs it. */ }
	}
	for (let directory of launch.writable ?? []) {
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
		} catch { /* The agent says so if it needs it. */ }
	}
	let places = writtenPlaces(launch);
	// The working directory is written only where the connector made it for this launch. Any
	// other is the person's own checkout, which is read, whole, and never written: what their git
	// reads and runs in it (its files and submodules' `.git`, its `.git`, its index) stays theirs.
	let person = places.includes(launch.cwd) ? undefined : real(launch.cwd);
	// Only the connector's record of the working directory says which repository this is, and so
	// where its git directories are: a folder the agent made itself, as a Planner's worktree,
	// names one in a file of its own, and what that file says is the agent's word.
	let repository = repositoryAt(real(launch.cwd));
	let git = repository ? gitAccess(repository, launch) : undefined;
	let hidden = real(options.directory);
	// The person's checkout and its git directory, which nothing the owner adds may open: a path
	// they add that is one of them, or inside one (a submodule's folder, `.git/hooks`), is not
	// granted, and one that holds one is granted with it held read-only. The person's own git reads
	// and runs what is in them.
	let checkout = repository && basename(repository.commonDir) === ".git"
		? dirname(repository.commonDir)
		: undefined;
	let theirs = [
		...person ? [person] : [],
		...repository ? [repository.commonDir] : [],
		...checkout ? [checkout] : [],
	];
	// What the owner adds is written around the state directory as well, never in it.
	let added = readGrantsAround(options.settings?.writable ?? [], hidden, disk, platform).filter(
		path => !theirs.some(kept => inside(real(path), kept, platform)),
	);
	let reopened = theirs.filter(kept =>
		added.some(path => real(path) !== kept && inside(kept, real(path), platform))
	);
	let writable = [
		...places,
		...git?.writable ?? [],
		...state,
		temporary,
		...added,
	].filter(path => exists(path));
	let roots: string[];
	if (platform === "win32") {
		roots = windowsReadRoots(launch.env, home, {
			directory: readableDirectory,
			list: directory => disk.list(directory),
		});
	} else if (platform === "darwin") {
		roots = ["/"];
	} else {
		roots = readableRoots(readdirSync("/")).filter(readableDirectory);
	}
	// Everything in the connector's state directory is out of sight but what the launch is given.
	// That holds for the working directory too, which may hold the state directory (a home, a
	// dotfiles checkout): it is read as the roots are, around the state directory, and a working
	// directory inside it is read whole only where it is a clone the connector made.
	let named = (path: string) => {
		let at = real(path);
		if (!inside(at, hidden, platform)) return readGrantsAround([at], hidden, disk, platform);
		let clones = join(hidden, CLONES);
		return at !== clones && inside(at, clones, platform) ? [at] : [];
	};
	// MXC takes a path granted both ways as read-only, so a grant that is also writable is dropped.
	let written = new Set(writable.map(real));
	let readable = [
		...readGrantsAround(roots, hidden, disk, platform),
		...(launch.own ?? []).filter(exists),
		...person ? named(person) : [],
		// The repository's git directory is read, whole, where only some roots are read (Windows).
		...repository ? named(repository.commonDir) : [],
	].filter(path => !written.has(real(path)));
	let readonlyInside = [...git?.readonlyInside ?? [], ...reopened];
	let denied = secretPaths(platform, home).filter(path => exists(path));
	let env: Record<string, string | undefined> = { ...launch.env };
	let pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = sandboxPath(env[pathKey], platform, real);
	env.NODE_USE_ENV_PROXY = "1";
	for (let key of platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"]) env[key] = temporary;
	return {
		platform,
		engine,
		command: launch.command,
		cwd: launch.cwd,
		env,
		readable,
		writable,
		readonlyInside,
		denied,
		proxy,
	};
}

function spawnConfined(
	executor: string,
	engine: SandboxEngine,
	host: Host,
	proxy: Proxy,
	options: SandboxOptions,
	launch: Launch,
): Spawned {
	let folder = mkdtempSync(join(tmpdir(), "chopin-sandbox-"));
	let temporary = join(folder, "tmp");
	mkdirSync(temporary, { mode: 0o700 });
	let file = join(folder, "request.json");
	// The policy leaves an agent no way to make a `commondir`, which would send git to configuration
	// it wrote (see `gitAccess`). One that an agent of an earlier release, or one that ran without a
	// sandbox, left is still removed, and said, when a launch starts and when it ends.
	let cleared = () => {
		let removed = removePlantedRedirects(launch.cwd);
		if (removed.length) options.planted?.(removed);
	};
	cleared();
	let request = mxcRequest(launchPolicy(engine, host, launch, options, proxy.url, temporary));
	writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
	let child = spawn(executor, ["--config", file], {
		stdio: [launch.stdin, "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	}) as Spawned;
	child.once("close", () => {
		rmSync(folder, { recursive: true, force: true });
		cleared();
	});
	child.once("error", () => rmSync(folder, { recursive: true, force: true }));
	return child;
}
