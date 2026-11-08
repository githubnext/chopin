import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
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
import { delimiter, dirname, join } from "node:path";
import type { SandboxReport } from "@chopin/protocol/connector";
import { type Host, probeSandbox } from "./sandbox-probe";
import {
	agentStateDirectories,
	allowedHosts,
	type Disk,
	mxcRequest,
	type Policy,
	readableRoots,
	readGrantsAround,
	type SandboxEngine,
	sandboxPath,
	type SandboxSettings,
	secretPaths,
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
	 * hold only that launch's, as a token is renewed by replacing its file.
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

/** The git directory a working tree shares with its checkout, where its commits and refs are written. */
function gitCommonDirectory(directory: string): string | undefined {
	let result = spawnSync("git", [
		"-C",
		directory,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	], { encoding: "utf8", timeout: 10_000 });
	let path = result.status === 0 ? result.stdout.trim() : "";
	return path && existsSync(path) ? path : undefined;
}

export type SandboxOptions = {
	/** The connector's state directory. */
	directory: string;
	/** Chopin's origin, which every run may reach. */
	server: string;
	settings?: SandboxSettings;
	/** Hears each host the proxy refuses, once. */
	refused?: (host: string, port: number) => void;
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
	let places = [launch.cwd, ...launch.writable ?? []];
	let commons = [...new Set(places.flatMap(place => gitCommonDirectory(real(place)) ?? []))];
	let writable = [
		...places,
		...commons,
		...state,
		temporary,
		...options.settings?.writable ?? [],
	].filter(path => exists(path));
	let roots: string[];
	if (platform === "win32") {
		roots = [
			home,
			...(launch.env.PATH ?? launch.env.Path ?? "").split(";").filter(entry =>
				entry && readableDirectory(entry)
			),
		];
	} else if (platform === "darwin") {
		roots = ["/"];
	} else {
		roots = readableRoots(readdirSync("/")).filter(readableDirectory);
	}
	// Everything in the connector's state directory is out of sight but what the launch is given.
	// MXC takes a path granted both ways as read-only, so a grant that is also writable is dropped.
	let written = new Set(writable.map(real));
	let readable = [
		...readGrantsAround(roots, real(options.directory), disk, platform),
		...(launch.own ?? []).filter(exists),
	].filter(path => !written.has(real(path)));
	let hooks = commons.map(common => join(common, "hooks")).filter(path => exists(path));
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
		readonlyInside: hooks,
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
	let request = mxcRequest(launchPolicy(engine, host, launch, options, proxy.url, temporary));
	writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
	let child = spawn(executor, ["--config", file], {
		stdio: [launch.stdin, "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	}) as Spawned;
	child.once("close", () => rmSync(folder, { recursive: true, force: true }));
	child.once("error", () => rmSync(folder, { recursive: true, force: true }));
	return child;
}
