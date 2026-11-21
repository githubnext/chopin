import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { arch, userInfo } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import type { SandboxReport } from "@chopin/protocol/connector";
import { type AiRelay, startAiRelay } from "./ai-relay";
import { GUEST_BRIDGE_PATH, guestBridge, guestBridgeCommand } from "./bridge";
import {
	type Downloader,
	ensureImage,
	type GuestUser,
	type ImageRecipe,
	pruneImages,
} from "./images";
import {
	type AgentImage,
	artifactsAt,
	deviceDenied,
	environmentFile,
	GUEST_WORK,
	guestProgram,
	type GuestRepository,
	type Hypervisor,
	type HypervisorDevice,
	makeWritable,
	nvxArguments,
	type NvxArtifacts,
	nvxDirectory,
	type NvxSupport,
	nvxSupport,
	programAt,
	SandboxRefused,
	STARTED_LINE,
	type SupportHost,
	unsupportedWords,
	type VmSpec,
	vmSpec,
} from "./nvx";
import { allowedHosts, type SandboxSettings, validAllowedEntry } from "./sandbox-policy";
import { type Proxy, startProxy } from "./sandbox-proxy";
import { killJob, sparseFile } from "./windows-host";
import { processStart, type StartProbe } from "./workspace";

export { SandboxRefused } from "./nvx";

/** What one agent or Planner process is started with, and what its microVM is given. */
export type Launch = {
	command: string[];
	cwd: string;
	/** The whole environment the process gets, before the guest's own (see `vmSpec`). */
	env: NodeJS.ProcessEnv;
	/** Whether it has a stdin to write to; its stdout and stderr are always pipes. */
	stdin: "pipe" | "ignore";
	/** Directories it writes beside its working directory, which are made where they aren't yet. */
	writable?: string[];
	/**
	 * Its own paths in the connector's state directory: its worktree, its token folder and its agent
	 * state. It reads them, and writes the ones that are also writable. A working directory among
	 * them is one the connector made for the launch, which it writes; any other is the person's
	 * checkout, which it only reads.
	 */
	own?: string[];
	/** The agent's state directory, made for this launch and among `own`, which it writes. */
	agentHome?: string;
	/** Host folders it only reads: a Planner's checkout, the person's, uncommitted files and all. */
	reads?: string[];
	/**
	 * The repository its guest clones and works in (see `GuestRepository`), from a git directory named
	 * by the connector's record of a checkout, never by a file in one.
	 */
	repository?: GuestRepository;
	/** The scratch disk its guest's writable root is on, which outlives it (a Planner's). */
	disk?: string;
};

/**
 * A started process: its stdout and stderr are always pipes. A microVM's is its launch, which may
 * start `nvx` more than once (see `startVm`): its `pid` is its current start's, and its process
 * group. On Windows it carries `stopMicrovm`, which ends it as `nvx` and OpenVMM need there (see
 * `startNvx`).
 */
export type Spawned = ChildProcess & {
	stdout: Readable;
	stderr: Readable;
	stopMicrovm?: (graceMs: number) => Promise<void>;
};

/** Where agents are started: each in a microVM of its own. */
export type Sandbox = {
	report: SandboxReport;
	/** Start `launch` in a microVM of its own. Throws a `SandboxRefused` for a launch it can't give one. */
	spawn(launch: Launch): Spawned;
	/** The loopback relay through which its launches reach Chopin's credential proxy. */
	aiRelay?: AiRelay;
	/** What a process its guest starts needs to reach out: the proxy's variables. */
	guestEnvironment?: Record<string, string>;
	/** How a run's agent starts the MCP bridge to Chopin's tools for its run, beside it. */
	bridge: { command: string; args: string[] };
	/** The folder its guests clone their repositories in (see `guestRepositoryPath`). */
	work: string;
	/**
	 * Makes the disk at `path` a launch's writable root lasts on (a Planner's, see `plannerDisk`):
	 * a sparse ext4 image of `DISK_GIB` GiB, made in a microVM; one already there is kept.
	 */
	makeDisk?(path: string): Promise<void>;
	allow?(entry: string): void;
	close(): Promise<void>;
};

/** A machine that can't run NVX: nothing pairs, connects or starts, and `words` say why. */
export class MachineUnsupported extends Error {
	override name = "MachineUnsupported";
	constructor(readonly support: Extract<NvxSupport, { supported: false }>) {
		super(unsupportedWords(support).join("\n"));
	}
}

/** Start `launch` in `sandbox`. There is no other way to start an agent. */
export function spawnIn(sandbox: Sandbox, launch: Launch): Spawned {
	return sandbox.spawn(launch);
}

/** The machine as the support check reads it. */
export function systemSupportHost(): SupportHost {
	return {
		platform: process.platform,
		arch: arch(),
		...process.getuid ? { uid: process.getuid() } : {},
		...process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {},
		exists: existsSync,
		readWrite(path) {
			try {
				accessSync(path, constants.R_OK | constants.W_OK);
				return true;
			} catch {
				return false;
			}
		},
		joinedLater(path) {
			try {
				let group = statSync(path).gid;
				if (group === 0 || process.getgid?.() === group) return false;
				if (process.getgroups?.().includes(group)) return false;
				// The group database as it is now, which `id` reads, where this process's groups are
				// those its login began with.
				let listed = spawnSync("id", ["-G", userInfo().username], {
					encoding: "utf8",
					timeout: 5_000,
				});
				return listed.status === 0
					&& listed.stdout.trim().split(/\s+/).map(Number).includes(group);
			} catch {
				return false;
			}
		},
	};
}

/**
 * How `nvx` is started: with a stdin or not, for a guest that owns nothing shared, who hears of a
 * microVM that outlived its stop (on Windows), and how long it waits first (a start tried again).
 */
export type StartOptions = {
	stdin: "pipe" | "ignore";
	open?: boolean;
	wedged?: (detail: string) => void;
	delayMs?: number;
};

/** Why this machine can't run microVMs, with the fix where there is one. */
export type Unsupported = Extract<NvxSupport, { supported: false }>;

/** How `startVm` starts `nvx`, and who hears what happens to its microVM. */
export type VmOptions = {
	/** Stands in for `nvx` in tests: what starts the command line. */
	start?: (program: string, words: string[], launch: StartOptions) => Spawned;
	/** Hears of a microVM that outlived its stop (on Windows). */
	wedged?: (detail: string) => void;
	/** Hears of a microVM that didn't start and is started again. */
	retrying?: (detail: string) => void;
	/**
	 * Hears, before the launch ends, that this machine can't run microVMs any more: OpenVMM wasn't
	 * allowed to open the hypervisor's device, as when logind took back a login's access to
	 * /dev/kvm. Nothing more starts until it can (see `connect`).
	 */
	unsupported?: (problem: Unsupported) => void;
	/** What those words read of the machine (`joinedLater`); the machine itself unless said. */
	host?: Pick<SupportHost, "joinedLater">;
};

/** What a microVM is built from: NVX and the hypervisor. */
export type NvxSetup = {
	artifacts: NvxArtifacts;
	hypervisor: Hypervisor;
};

export type SandboxOptions = {
	/** The connector's state directory. */
	directory: string;
	/** Chopin's origin, which every guest may reach through the proxy. */
	server: string;
	settings?: SandboxSettings;
	setup: NvxSetup;
	/** How to make the image of each program an agent's command may start, by its file name. */
	recipes: Map<string, ImageRecipe>;
	/** Fetches what images are made from; `fetch` by default. */
	download?: Downloader;
	/** Hears that an image is being built, which takes minutes the first time. */
	building?: (recipe: ImageRecipe) => void;
	/** Hears each host the proxy refuses, once. */
	refused?: (host: string, port: number) => void;
	/** Hears of a microVM that outlived its stop (on Windows), which a restart may be needed to end. */
	wedged?: (detail: string) => void;
	/** Hears of a microVM that didn't start and is started again. */
	retrying?: (detail: string) => void;
	/** Hears that this machine can't run microVMs any more, and why (see `VmOptions`). */
	unsupported?: (problem: Unsupported) => void;
	/** The machine as the support check reads it; the machine itself unless said. */
	host?: SupportHost;
	/** Stands in for `nvx` in tests: what starts the command line. */
	start?: (program: string, words: string[], launch: StartOptions) => Spawned;
	/**
	 * Whether the images no recipe here names go, as a connector that holds the base dir removes
	 * them. False for a check beside a running connector, whose images they may be.
	 */
	prune?: boolean;
};

/** The connector's records of the microVMs it started, which a connector that died left behind. */
function launchesFolder(base: string) {
	return join(base, "nvx", "launches");
}

/**
 * Ends what a connector that died left running: each recorded `nvx` process group, OpenVMM in it,
 * whose connector is gone, and removes the records with the folder each `nvx` kept in the temporary
 * directory. A process is ended only while it is still the one recorded (`processStart`'s id,
 * recorded as it started): a number reused since, after a restart or days later, is never
 * signalled, and a record without one ends nothing. A launch of a chopin still running beside this
 * one on the state directory (the service, while a terminal's `service install` checks the agent) is
 * left alone. On Windows a connector's job objects ended its microVMs as it died (see
 * `windowsStop`), so only the records and folders go.
 */
export async function endOrphans(base: string, probe: StartProbe = processStart()) {
	let folder = launchesFolder(base);
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return;
	}
	let same = async (pid: unknown, start: unknown) =>
		typeof pid === "number" && pid > 1 && typeof start === "string"
		&& (await probe(pid).catch(() => undefined))?.id === start;
	for (let name of names) {
		let record = join(folder, name, "launch.json");
		let launch: {
			pid?: unknown;
			start?: unknown;
			owner?: unknown;
			ownerStart?: unknown;
			run?: unknown;
		};
		try {
			launch = JSON.parse(readFileSync(record, "utf8"));
		} catch {
			// No record: an interrupted start, or one of another chopin's still being made.
			let made = statSync(join(folder, name), { throwIfNoEntry: false })?.mtimeMs ?? 0;
			if (Date.now() - made < 60_000) continue;
			rmSync(join(folder, name), { recursive: true, force: true });
			continue;
		}
		let { owner } = launch;
		if (typeof owner === "number" && owner !== process.pid) {
			// Its chopin still runs: by its recorded start where there is one, else by its number.
			if (launch.ownerStart === undefined ? alive(owner) : await same(owner, launch.ownerStart)) {
				continue;
			}
		}
		if (process.platform !== "win32" && await same(launch.pid, launch.start)) {
			try {
				process.kill(-(launch.pid as number), "SIGKILL");
			} catch { /* Gone already. */ }
		}
		if (typeof launch.run === "string" && RUN_FOLDER.test(basename(launch.run))) {
			removeRunFolder(launch.run);
		}
		rmSync(join(folder, name), { recursive: true, force: true });
	}
}

/** What `nvx sandbox run` calls the folder it keeps in the temporary directory for one run. */
const RUN_FOLDER = /^nvx-sandbox-run-[0-9a-f]+$/;

/**
 * The folder `nvx` keeps for a run, from the OpenVMM command line it prints as it starts one, where
 * OpenVMM's report and log are: `--microvm-report <folder>/outcome.json`. Undefined for a line that
 * names none.
 */
export function runFolderOf(line: string, platform: NodeJS.Platform = process.platform) {
	let match = /--microvm-report[ =](?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line);
	let report = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!report) return undefined;
	let paths = platform === "win32" ? win32 : posix;
	let folder = paths.dirname(report);
	return RUN_FOLDER.test(paths.basename(folder)) ? folder : undefined;
}

/**
 * Removes a run's folder of `nvx`'s. On Windows OpenVMM may hold its log a moment after `nvx`
 * ended, and it is tried again for a few seconds; one that still can't go is left to the next sweep.
 */
function removeRunFolder(path: string) {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		void rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
	}
}

/**
 * Where `nvx` keeps its runs' folders: the temporary directory as Rust finds it (`std::env::temp_dir`),
 * which on Linux is `TMPDIR` alone, where Node's would read `TMP` and `TEMP` too, and on Windows is
 * `GetTempPath`'s.
 */
export function nvxTemporary(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform !== "win32") return env.TMPDIR || "/tmp";
	return env.TMP || env.TEMP || env.USERPROFILE || env.SystemRoot || "C:\\Windows";
}

/** The command lines of the processes running on this machine; undefined where they can't be read. */
async function commandLines(): Promise<string[] | undefined> {
	if (process.platform === "linux") {
		let entries = await readdir("/proc").catch(() => undefined);
		if (!entries) return undefined;
		let lines = await Promise.all(
			entries.filter(entry => /^\d+$/.test(entry)).map(entry =>
				readFile(`/proc/${entry}/cmdline`, "latin1").catch(() => "")
			),
		);
		return lines.filter(Boolean);
	}
	if (process.platform === "win32") {
		return new Promise(resolve =>
			execFile(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
				],
				{ timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
				(error, stdout) => resolve(error ? undefined : stdout.split(/\r?\n/).filter(Boolean)),
			)
		);
	}
	return undefined;
}

/**
 * Removes the folders `nvx sandbox run` kept in the temporary directory that no microVM uses any
 * more. `nvx` removes its own as a run ends by itself, but not one ended by force, as the
 * connector ends a launch it stops: that keeps OpenVMM's log and little else, and one is left for
 * each. A launch removes its own as it ends (see `startVm`); this finds those of a connector that
 * died first, or of an earlier `chopin`. Only the connector's user's folders are looked at, and a
 * folder is kept while a launch's record names it, while it is younger than a minute (an `nvx`
 * starting), or while a running process names it, as OpenVMM's command line does for its whole run:
 * a microVM of another chopin, on another base dir, or of anything else of the person's that runs
 * NVX. Where the processes can't be read, every folder is kept.
 */
export async function sweepRunFolders(
	base: string,
	temporary = nvxTemporary(),
	running: () => Promise<string[] | undefined> = commandLines,
) {
	let names: string[];
	try {
		names = readdirSync(temporary).filter(name => RUN_FOLDER.test(name));
	} catch {
		return;
	}
	if (!names.length) return;
	let recorded = new Set<string>();
	let launches = launchesFolder(base);
	let records: string[];
	try {
		records = readdirSync(launches);
	} catch {
		records = [];
	}
	for (let name of records) {
		try {
			let { run } = JSON.parse(readFileSync(join(launches, name, "launch.json"), "utf8")) as {
				run?: unknown;
			};
			if (typeof run === "string") recorded.add(basename(run));
		} catch { /* A launch still starting, which has no folder yet. */ }
	}
	let uid = process.getuid?.();
	let left = names.filter(name => {
		if (recorded.has(name)) return false;
		let stat = lstatSync(join(temporary, name), { throwIfNoEntry: false });
		return !!stat && stat.isDirectory() && (uid === undefined || stat.uid === uid)
			&& Date.now() - stat.mtimeMs > 60_000;
	});
	if (!left.length) return;
	let lines = await running();
	if (!lines) return;
	for (let name of left) {
		if (lines.some(line => line.includes(name))) continue;
		removeRunFolder(join(temporary, name));
	}
}

/** This process's start, as `processStart` reads it, asked once. */
let ownStart: Promise<string | undefined> | undefined;

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** How `nvx` starts on Linux: as it is. */
export const NVX_LAUNCHER = 'exec "$0" "$@"';

/**
 * How `nvx` starts for a guest of the layer's `nobody` (an image's build), which owns nothing
 * shared: OpenVMM makes what it asks for in its shares with the guest's modes narrowed by its own
 * umask, which is cleared, so it can write what it made. Only an image's build folder, in the
 * `0700` state directory, is shared with one.
 */
export const OPEN_NVX_LAUNCHER = `umask 000; ${NVX_LAUNCHER}`;

/** What OpenVMM's log says when it couldn't set up a microVM's disk, as under heavy load it can't. */
export const IO_URING_FAILURE = "driver does not support io-uring";

/** What OpenVMM's log says when this machine's user may not open the hypervisor's device. */
export const DEVICE_DENIED =
	/failed to open file `(\/dev\/(?:kvm|mshv))`: Permission denied(?: \(os error \d+\))?/;

/** How many times one launch's microVM is started at most: once, and twice more after that. */
export const VM_STARTS = 3;

/** How long each start after the first waits before it starts, in milliseconds. */
export const START_AGAIN_MS = [500, 1_500];

/** The most of OpenVMM's log a start's failure says, in characters. */
const LOG_TAIL_CHARS = 1_000;

/** One start of a launch's microVM: one `nvx` process. */
type Attempt = {
	child: Spawned;
	/** Whether `nvx` printed the OpenVMM command line it starts (see `runFolderOf`). */
	launched: boolean;
	/** The folder `nvx` keeps for the run, which its launch line names. */
	run?: string;
	/** OpenVMM's log in it, open from the launch line on: `nvx` removes it as a failed start ends. */
	log?: number;
	/** Whether the guest said its workload starts (see `STARTED_LINE`). */
	started: boolean;
	/** What `nvx` said on stderr before then: its own words, as why a start failed. */
	said: Buffer[];
	/** The end of OpenVMM's log, read as a start that never started its workload exits. */
	tail: string;
	/** Why it didn't start, where that is that this machine can't run microVMs any more. */
	unsupported?: Unsupported;
	/** How it exited. */
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Resolves once it has exited and its stdout and stderr have ended. */
	closed: Promise<void>;
};

/** The end of OpenVMM's log: its last fatal error with its causes, else its last lines. */
function logTail(fd: number | undefined): string {
	if (fd === undefined) return "";
	let text: string;
	try {
		let size = fstatSync(fd).size;
		let length = Math.min(size, 16_384);
		let buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		text = buffer.toString("utf8");
	} catch {
		return "";
	}
	let lines = text.split("\n").map(line => line.trim()).filter(Boolean);
	let fatal = lines.findLastIndex(line => line.startsWith("fatal error"));
	let tail = (fatal >= 0 ? lines.slice(fatal) : lines.slice(-5)).join(" / ");
	return tail.length > LOG_TAIL_CHARS ? `…${tail.slice(-LOG_TAIL_CHARS)}` : tail;
}

/**
 * Starts the microVM `spec` describes: its writable folders made and opened to the guest, its
 * environment in a private file `nvx` reads, and a record of its process group, which a connector
 * that died leaves for the next to end (see `endOrphans`). The record names the folder `nvx` keeps
 * in the temporary directory too. All of them go when the launch ends, however it ends.
 *
 * What it returns is the launch, not one `nvx`: OpenVMM sometimes fails to start a microVM under
 * heavy load, saying `IO_URING_FAILURE` in its log, and such a start is tried again, up to
 * `VM_STARTS` times in all, after a short wait. Only a start whose workload never started is: the
 * guest says the workload starts on its stdout before it runs it (`STARTED_LINE`), and until then
 * nothing of the launch's stdin reaches the guest and nothing of `nvx`'s stderr reaches the
 * caller, so an agent never sees two starts. A start that fails for good says why on stderr, with
 * the end of OpenVMM's log, where `nvx` itself says only `vmm-failure status 1`.
 *
 * On Linux the wait before a new start is in that start's own process group (`delayMs`), so a
 * caller that ends the launch's process group meanwhile ends it. On Windows, where a caller stops a
 * launch through `stopMicrovm`, the launch waits, and a stop meanwhile ends it.
 */
export function startVm(
	spec: VmSpec,
	setup: NvxSetup,
	base: string,
	stdin: "pipe" | "ignore",
	options: VmOptions = {},
): Spawned {
	let start = options.start ?? startNvx;
	makeWritable(spec);
	let folder = join(launchesFolder(base), randomBytes(8).toString("hex"));
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	let file = join(folder, "environment.json");
	writeFileSync(file, environmentFile(spec.environment), { mode: 0o600 });
	let words = nvxArguments(spec, setup.artifacts, setup.hypervisor, file);
	let current: Attempt | undefined;
	let starts = 0;
	let stopped = false;
	let settled = false;
	/** A start waiting to be tried again, on Windows. */
	let waiting: ReturnType<typeof setTimeout> | undefined;
	/** What the launch's stdin was given before its workload started, and whether it was ended. */
	let queue: Buffer[] = [];
	let ending = false;
	let record: Record<string, unknown> = {};
	let save = (attempt: Attempt, fields: Record<string, unknown>) => {
		if (attempt !== current || !existsSync(folder)) return;
		Object.assign(record, fields);
		writeFileSync(join(folder, "launch.json"), JSON.stringify(record), { mode: 0o600 });
	};
	let input = stdin === "pipe"
		? new Writable({
			write(chunk: Buffer, _encoding, done) {
				if (current?.started) current.child.stdin?.write(chunk);
				else queue.push(chunk);
				done();
			},
			final(done) {
				if (current?.started) current.child.stdin?.end();
				else ending = true;
				done();
			},
		})
		: null;
	let launch = Object.assign(new EventEmitter(), {
		stdin: input,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		kill(signal?: NodeJS.Signals | number) {
			stopped = true;
			if (waiting) return giveUp();
			return current?.child.kill(signal) ?? false;
		},
	});
	Object.defineProperty(launch, "pid", { enumerable: true, get: () => current?.child.pid });
	if (process.platform === "win32") {
		Object.assign(launch, {
			stopMicrovm(graceMs: number) {
				stopped = true;
				if (waiting) giveUp();
				return current?.child.stopMicrovm?.(graceMs) ?? Promise.resolve();
			},
		});
	}
	let release = (attempt: Attempt) => {
		if (attempt.log !== undefined) {
			try {
				closeSync(attempt.log);
			} catch { /* Closed already. */ }
			attempt.log = undefined;
		}
		if (attempt.run) removeRunFolder(attempt.run);
	};
	let started = (attempt: Attempt) => {
		attempt.started = true;
		for (let chunk of attempt.said) launch.stderr.write(chunk);
		attempt.said = [];
		for (let chunk of queue) attempt.child.stdin?.write(chunk);
		queue = [];
		if (ending) attempt.child.stdin?.end();
	};
	/** The launch ends with `attempt`, the last start of its microVM. */
	let settle = async (attempt: Attempt, errored = false) => {
		if (settled) return;
		settled = true;
		launch.exitCode = attempt.code;
		launch.signalCode = attempt.signal;
		if (!errored) launch.emit("exit", attempt.code, attempt.signal);
		await attempt.closed;
		if (!attempt.started) {
			let said = Buffer.concat(attempt.said).toString("utf8").trim();
			let log = attempt.tail || logTail(attempt.log);
			if (attempt.unsupported) {
				launch.stderr.write(
					`${unsupportedWords(attempt.unsupported).join(" ")} (OpenVMM: ${
						DEVICE_DENIED.exec(log)?.[0]
					})\n`,
				);
			} else if (attempt.code !== null && attempt.code !== 0 && log) {
				launch.stderr.write(
					`The microVM didn't start${starts > 1 ? ` after ${starts} tries` : ""}: ${log}${
						said ? ` (nvx: ${said.split(/\s*\n\s*/).join(" ")})` : ""
					}\n`,
				);
			} else if (said) launch.stderr.write(`${said}\n`);
			input?.destroy();
		}
		release(attempt);
		rmSync(folder, { recursive: true, force: true });
		launch.stdout.end();
		launch.stderr.end();
		launch.emit("close", attempt.code, attempt.signal);
	};
	/** A launch stopped while it waited to start again ends with the start that failed. */
	let giveUp = () => {
		clearTimeout(waiting);
		waiting = undefined;
		if (current) void settle(current);
		return true;
	};
	let begin = (delayMs: number) => {
		let child = start(setup.artifacts.nvx, words, {
			stdin,
			open: !spec.image,
			...options.wedged ? { wedged: options.wedged } : {},
			...delayMs ? { delayMs } : {},
		});
		starts++;
		let attempt: Attempt = {
			child,
			launched: false,
			started: false,
			said: [],
			tail: "",
			code: null,
			signal: null,
			closed: new Promise(resolve => {
				child.once("close", () => resolve());
				child.once("error", () => resolve());
			}),
		};
		current = attempt;
		if (child.pid) {
			let pid = child.pid;
			record = { pid, owner: process.pid };
			save(attempt, {});
			// What identifies it and this process, so a later connector ends only this process.
			let probe = processStart();
			ownStart ??= probe(process.pid).then(found => found?.id, () => undefined);
			void Promise.all([probe(pid).catch(() => undefined), ownStart]).then(([found, owner]) => {
				if (found) save(attempt, { start: found.id, ...owner ? { ownerStart: owner } : {} });
			}).catch(() => {});
		}
		child.stdin?.on("error", error => {
			if (attempt === current && attempt.started) input?.destroy(error);
		});
		let pending = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (attempt !== current) return;
			if (attempt.started) {
				launch.stdout.write(chunk);
				return;
			}
			// `nvx`'s launch line, then the guest's started line; anything else is the workload's own.
			pending += chunk.toString("latin1");
			for (;;) {
				let end = pending.indexOf("\n");
				let line = (end < 0 ? pending : pending.slice(0, end)).replace(/\r$/, "");
				if (end < 0 && (line.startsWith(">> ") || ">> ".startsWith(line))) return;
				if (end >= 0 && line === STARTED_LINE) {
					pending = pending.slice(end + 1);
				} else if (end >= 0 && line.startsWith(">> ") && !attempt.launched) {
					pending = pending.slice(end + 1);
					attempt.launched = true;
					attempt.run = runFolderOf(line);
					if (!attempt.run) continue;
					save(attempt, { run: attempt.run });
					try {
						attempt.log = openSync(join(attempt.run, "openvmm.log"), "r");
					} catch { /* Gone already: a start that failed at once. */ }
					continue;
				}
				break;
			}
			started(attempt);
			if (pending) launch.stdout.write(Buffer.from(pending, "latin1"));
			pending = "";
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (attempt !== current) return;
			if (attempt.started) launch.stderr.write(chunk);
			else attempt.said.push(chunk);
		});
		child.once("exit", (code, signal) => {
			attempt.code = code;
			attempt.signal = signal;
			if (attempt !== current) return;
			if (!attempt.started) attempt.tail = logTail(attempt.log);
			let denied = !attempt.started && code !== 0 && DEVICE_DENIED.exec(attempt.tail)?.[1];
			if (denied) {
				let device = denied as HypervisorDevice;
				attempt.unsupported = deviceDenied(device, options.host ?? systemSupportHost());
				options.unsupported?.(attempt.unsupported);
			}
			let again = !attempt.started && !stopped && code !== null && code !== 0
				&& starts < VM_STARTS && attempt.tail.includes(IO_URING_FAILURE);
			if (!again) {
				void settle(attempt);
				return;
			}
			release(attempt);
			options.retrying?.(
				`A microVM didn't start (OpenVMM: ${IO_URING_FAILURE}), so chopin starts it again (${
					starts + 1
				} of ${VM_STARTS}).`,
			);
			let wait = START_AGAIN_MS[starts - 1] ?? 0;
			let next = () => {
				try {
					begin(process.platform === "win32" ? 0 : wait);
				} catch (error) {
					launch.emit("error", error);
					void settle(attempt, true);
				}
			};
			if (process.platform !== "win32") next();
			else {
				waiting = setTimeout(() => {
					waiting = undefined;
					next();
				}, wait);
			}
		});
		child.once("error", error => {
			if (attempt !== current || settled) return;
			launch.emit("error", error);
			void settle(attempt, true);
		});
	};
	try {
		begin(0);
	} catch (error) {
		// A launch that never started, as on Windows without its job object, leaves no tokens.
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
	return launch as unknown as Spawned;
}

/** Runs `spec`'s microVM to its end, as an image build or the start check does. */
export function runVm(
	spec: VmSpec,
	setup: NvxSetup,
	base: string,
	options: VmOptions = {},
): Promise<{ code: number | null; output: string }> {
	let child = startVm(spec, setup, base, "ignore", options);
	let output = "";
	child.stdout.on("data", chunk => output = (output + chunk).slice(-65_536));
	child.stderr.on("data", chunk => output = (output + chunk).slice(-65_536));
	return new Promise(resolve => {
		child.once("error", error => resolve({ code: null, output: output + error.message }));
		child.once("close", code => resolve({ code, output }));
	});
}

/**
 * The guest's user: the connector's own on Linux, so it owns what is shared with it. Windows
 * reports every shared file as everyone's, so any account would do; the image's is 1000.
 */
export function guestUser(): GuestUser {
	return process.getuid && process.getgid
		? { uid: process.getuid(), gid: process.getgid() }
		: { uid: 1000, gid: 1000 };
}

/** How large a Planner's disk may grow, in GiB: its image is sparse, so it takes what it holds. */
export const DISK_GIB = 32;

/**
 * Makes a sparse ext4 image at `path`: the file made sparse on the host, which takes on disk only
 * what is written to it (on Windows NTFS fills a file a guest grows), then formatted in a microVM of
 * the release's own layer, whose `mkfs.ext4` needs nothing of the host's, without discards, which
 * NTFS doesn't take. A new sparse file reads as zeros, which `mkfs.ext4` is told, so the guest's
 * kernel never writes zeros over its inode tables (half a GiB at 32 GiB). One that is there already
 * is kept.
 */
export async function makeDisk(
	path: string,
	setup: NvxSetup,
	base: string,
	proxyPort: number,
	options: VmOptions = {},
) {
	if (existsSync(path)) return;
	let work = join(base, "nvx", "disks", randomBytes(6).toString("hex"));
	mkdirSync(work, { recursive: true });
	let made = join(work, "disk.ext4");
	try {
		let bytes = DISK_GIB * 1024 ** 3;
		if (process.platform === "win32") sparseFile(made, bytes);
		else {
			writeFileSync(made, "");
			truncateSync(made, bytes);
			// The guest that formats it is the layer's own `nobody`.
			chmodSync(work, 0o777);
			chmodSync(made, 0o666);
		}
		let result = await runVm(
			{
				shares: [{ host: work, guest: "/out", mode: "rw" }],
				proxyPort,
				environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
				command: [
					"mkfs.ext4",
					"-q",
					"-F",
					"-m",
					"0",
					"-E",
					"lazy_itable_init=1,lazy_journal_init=1,assume_storage_prezeroed=1,nodiscard",
					"/out/disk.ext4",
				],
				cwd: "/tmp",
				memoryMib: 512,
				processors: 1,
				hostname: "chopin-disk",
			},
			setup,
			base,
			options,
		);
		if (result.code !== 0) {
			throw new Error(
				`Couldn't make a disk for a microVM (exit ${result.code}): ${
					result.output.trim().split("\n").at(-1) ?? ""
				}`,
			);
		}
		if (process.platform !== "win32") chmodSync(made, 0o600);
		renameSync(made, path);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Where an agent's start check runs in its microVM: an empty folder in the state directory, which a
 * guest only reads. It needs nothing of a checkout, and never the home folder, which holds the state
 * directory and everything a person keeps.
 */
export function checkFolder(base: string) {
	let folder = join(base, "nvx", "check");
	mkdirSync(folder, { recursive: true });
	return folder;
}

/** Fetches `url` into `path`. */
export async function fetchTo(url: string, path: string) {
	let response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Couldn't download ${url} (${response.status}).`);
	}
	await Bun.write(path, response);
}

/**
 * The guest starts nothing but `nvx`'s own command line, with the environment in a private file.
 * A start that waits first waits in its own process group (see `startVm`); on Windows the launch
 * waits instead.
 */
export function startNvx(program: string, words: string[], launch: StartOptions): Spawned {
	let launcher = `${launch.delayMs ? `sleep ${launch.delayMs / 1000}; ` : ""}${
		launch.open ? OPEN_NVX_LAUNCHER : NVX_LAUNCHER
	}`;
	let [command, args] = process.platform === "win32"
		? [program, words]
		: ["/bin/sh", ["-c", launcher, program, ...words]];
	let child = spawn(command, args, {
		stdio: [launch.stdin, "pipe", "pipe"],
		// Its own process group, with OpenVMM in it, so ending the launch ends the microVM.
		detached: process.platform !== "win32",
		windowsHide: true,
	}) as Spawned;
	if (process.platform === "win32" && child.pid) windowsStop(child, launch.wedged);
	return child;
}

/**
 * How a microVM ends on Windows, where killing `nvx.exe` leaves OpenVMM running and a VM killed in
 * the middle of share I/O can wedge until Windows restarts. `nvx.exe` goes in a job that ends
 * OpenVMM with it. Stopping first ends its stdin and waits `graceMs` for the workload, and so the
 * VM, to end by itself; only then is the job killed. A VM still running 10 seconds after that is
 * reported as wedged rather than taken for gone.
 */
function windowsStop(child: Spawned, wedged?: (detail: string) => void) {
	let job = killJob(child.pid!);
	// Without its job a VM would outlive its stop and chopin itself: it never runs.
	if (!job) {
		child.kill();
		throw new SandboxRefused(
			"Not run: chopin couldn't put the microVM in a job object, which ends it with chopin.",
		);
	}
	let exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	let ended = (ms: number) =>
		Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)]);
	child.once("close", () => job.close());
	let stopping: Promise<void> | undefined;
	child.stopMicrovm = graceMs =>
		stopping ??= (async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			try {
				child.stdin?.end();
			} catch { /* Already closed. */ }
			if (await ended(graceMs)) return;
			job.kill();
			if (await ended(10_000) && !job.active()) return;
			wedged?.(
				`A microVM (nvx.exe ${child.pid}) didn't end when it was stopped, so OpenVMM may still `
					+ "hold its memory until Windows restarts.",
			);
		})();
}

/**
 * The machine's microVMs: every launch in an NVX guest of its own, its only way out the allow-list
 * proxy on loopback, through which it reaches Chopin, the hosts it may and the AI relay.
 */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
	let settings = options.settings ?? {};
	let { setup, directory } = options;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	// The state directory keeps what guests may write from the host's other users.
	if (process.platform !== "win32") chmodSync(directory, statSync(directory).mode & 0o700);
	await endOrphans(directory);
	await sweepRunFolders(directory);
	// Before anything is started that would have to be stopped again were it to fail.
	let bridge = await guestBridge(directory);
	let aiRelay = startAiRelay();
	let hosts = [...allowedHosts(options.server, settings.hosts), aiRelay.host];
	let proxy: Proxy = await startProxy({
		hosts,
		refused: (name, port) => options.refused?.(name, port),
	});
	let vm: VmOptions = {
		...options.start ? { start: options.start } : {},
		...options.wedged ? { wedged: options.wedged } : {},
		...options.retrying ? { retrying: options.retrying } : {},
		...options.unsupported ? { unsupported: options.unsupported } : {},
		...options.host ? { host: options.host } : {},
	};
	let images = new Map<string, AgentImage>();
	try {
		for (let [program, recipe] of options.recipes) {
			images.set(
				program,
				await ensureImage(recipe, {
					base: directory,
					layer: setup.artifacts.layer,
					user: guestUser(),
					run: spec => runVm(spec, setup, directory, vm),
					download: options.download ?? fetchTo,
					proxyPort: proxy.port,
					...options.building ? { building: options.building } : {},
				}),
			);
		}
		if (options.prune !== false) {
			await pruneImages(
				directory,
				[...images.values()].map(image => basename(image.layer.path, ".erofs")),
			);
		}
	} catch (error) {
		await proxy.close();
		await aiRelay.close();
		throw error;
	}
	return {
		report: { engine: "nvx", hypervisor: setup.hypervisor },
		spawn(launch) {
			let program = guestProgram(
				launch.command[programAt(launch.command)] ?? "",
				process.platform,
			);
			let image = images.get(program);
			if (!image) {
				throw new SandboxRefused(
					`Not run: chopin has no image with ${program || "this command"} for its microVM.`,
				);
			}
			let spec = vmSpec(launch, {
				platform: process.platform,
				base: directory,
				image,
				proxyPort: proxy.port,
				...settings.writable ? { writable: settings.writable } : {},
				...settings.hidden ? { hidden: settings.hidden } : {},
				files: [{ host: bridge, guest: GUEST_BRIDGE_PATH }],
			});
			return startVm(spec, setup, directory, launch.stdin, vm);
		},
		aiRelay,
		bridge: guestBridgeCommand(),
		work: GUEST_WORK,
		makeDisk: path => makeDisk(path, setup, directory, proxy.port, vm),
		guestEnvironment: {
			HTTPS_PROXY: `http://10.0.0.1:${proxy.port}`,
			HTTP_PROXY: `http://10.0.0.1:${proxy.port}`,
			NO_PROXY: "",
			NODE_USE_ENV_PROXY: "1",
		},
		allow(entry) {
			if (validAllowedEntry(entry) && !hosts.includes(entry)) hosts.push(entry);
		},
		close: async () => {
			await proxy.close();
			await aiRelay.close();
		},
	};
}

/**
 * NVX where the connector keeps it, or where `CHOPIN_NVX_ROOT` names an extracted package (a
 * machine without the network, or a build of one's own).
 */
export function installedArtifacts(
	directory: string,
	env: Record<string, string | undefined> = process.env,
	platform = process.platform,
): NvxArtifacts | undefined {
	let root = env.CHOPIN_NVX_ROOT;
	if (root) return artifactsAt(root, platform);
	let at = nvxDirectory(directory);
	return existsSync(join(at, ".verified")) ? artifactsAt(at, platform) : undefined;
}

/**
 * What `chopin status` and Chopin hear of where this machine's agents run: NVX on its hypervisor,
 * or why it can't, with the fix.
 */
export function machineReport(host: SupportHost = systemSupportHost()): SandboxReport {
	let support = nvxSupport(host);
	return support.supported
		? { engine: "nvx", hypervisor: support.hypervisor }
		: { engine: "none", reason: support.reason, ...support.fix ? { fix: support.fix } : {} };
}

/** Whether this machine can run NVX, or why not; throws `MachineUnsupported` when it can't. */
export function requireSupport(host: SupportHost = systemSupportHost()) {
	let support = nvxSupport(host);
	if (!support.supported) throw new MachineUnsupported(support);
	return support;
}
