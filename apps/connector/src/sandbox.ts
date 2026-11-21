import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { arch } from "node:os";
import { basename, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
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
	environmentFile,
	GUEST_WORK,
	guestProgram,
	type GuestRepository,
	type Hypervisor,
	makeWritable,
	nvxArguments,
	type NvxArtifacts,
	nvxDirectory,
	type NvxSupport,
	nvxSupport,
	programAt,
	SandboxRefused,
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
 * A started process: its stdout and stderr are always pipes. On Windows a microVM's carries
 * `stopMicrovm`, which ends it as `nvx` and OpenVMM need there (see `startNvx`).
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
	};
}

/**
 * How `nvx` is started: with a stdin or not, for a guest that owns nothing shared, and who hears of
 * a microVM that outlived its stop (on Windows).
 */
export type StartOptions = {
	stdin: "pipe" | "ignore";
	open?: boolean;
	wedged?: (detail: string) => void;
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
	/** Stands in for `nvx` in tests: what starts the command line. */
	start?: (program: string, words: string[], launch: StartOptions) => Spawned;
};

/** The connector's records of the microVMs it started, which a connector that died left behind. */
function launchesFolder(base: string) {
	return join(base, "nvx", "launches");
}

/**
 * Ends what a connector that died left running: each recorded `nvx` process group, OpenVMM in it,
 * whose connector is gone, and removes the records. A process is ended only while it is still the
 * one recorded (`processStart`'s id, recorded as it started): a number reused since, after a
 * restart or days later, is never signalled, and a record without one ends nothing. A launch of a
 * chopin still running beside this one on the state directory (the service, while a terminal's
 * `service install` checks the agent) is left alone. On Windows a connector's job objects ended its
 * microVMs as it died (see `windowsStop`), so only the records go.
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
		let launch: { pid?: unknown; start?: unknown; owner?: unknown; ownerStart?: unknown };
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
		rmSync(join(folder, name), { recursive: true, force: true });
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

/**
 * `nvx` prints the OpenVMM command it starts on stdout, as `>> <command>`, before the workload's
 * own output, which on an agent's stdout is its protocol. That first line goes.
 */
export function withoutLaunchLine(stdout: Readable): Readable {
	let pending = "";
	let done = false;
	let output = new PassThrough();
	stdout.on("data", (chunk: Buffer) => {
		if (done) {
			output.write(chunk);
			return;
		}
		pending += chunk.toString("latin1");
		if (!pending.startsWith(">> ".slice(0, pending.length))) {
			done = true;
			output.write(Buffer.from(pending, "latin1"));
			return;
		}
		let end = pending.indexOf("\n");
		if (end === -1) return;
		done = true;
		let rest = pending.slice(end + 1);
		if (rest) output.write(Buffer.from(rest, "latin1"));
	});
	stdout.once("end", () => {
		if (!done && pending && !pending.startsWith(">> ")) {
			output.write(Buffer.from(pending, "latin1"));
		}
		output.end();
	});
	stdout.once("error", error => output.destroy(error));
	return output;
}

/**
 * Starts the microVM `spec` describes: its writable folders made and opened to the guest, its
 * environment in a private file `nvx` reads, and a record of its process group, which a connector
 * that died leaves for the next to end (see `endOrphans`). Both go when it exits.
 */
export function startVm(
	spec: VmSpec,
	setup: NvxSetup,
	base: string,
	stdin: "pipe" | "ignore",
	start: (program: string, words: string[], launch: StartOptions) => Spawned = startNvx,
	wedged?: (detail: string) => void,
): Spawned {
	makeWritable(spec);
	let folder = join(launchesFolder(base), randomBytes(8).toString("hex"));
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	let file = join(folder, "environment.json");
	writeFileSync(file, environmentFile(spec.environment), { mode: 0o600 });
	let child: Spawned;
	try {
		child = start(
			setup.artifacts.nvx,
			nvxArguments(spec, setup.artifacts, setup.hypervisor, file),
			{
				stdin,
				open: !spec.image,
				...wedged ? { wedged } : {},
			},
		);
	} catch (error) {
		// A launch that never started, as on Windows without its job object, leaves no tokens.
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
	if (child.pid) {
		let pid = child.pid;
		let record = join(folder, "launch.json");
		writeFileSync(record, JSON.stringify({ pid, owner: process.pid }), { mode: 0o600 });
		// What identifies it and this process, so a later connector ends only this process.
		let probe = processStart();
		ownStart ??= probe(process.pid).then(found => found?.id, () => undefined);
		void Promise.all([probe(pid).catch(() => undefined), ownStart]).then(([start, owner]) => {
			if (!start || !existsSync(folder)) return;
			writeFileSync(
				record,
				JSON.stringify({
					pid,
					start: start.id,
					owner: process.pid,
					...owner ? { ownerStart: owner } : {},
				}),
				{ mode: 0o600 },
			);
		}).catch(() => {});
	}
	let removed = false;
	let remove = () => {
		if (removed) return;
		removed = true;
		rmSync(folder, { recursive: true, force: true });
	};
	child.once("close", remove);
	child.once("error", remove);
	return child;
}

/** Runs `spec`'s microVM to its end, as an image build or the start check does. */
export function runVm(
	spec: VmSpec,
	setup: NvxSetup,
	base: string,
	start?: (program: string, words: string[], launch: StartOptions) => Spawned,
): Promise<{ code: number | null; output: string }> {
	let child = startVm(spec, setup, base, "ignore", start);
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
 * NTFS doesn't take. One that is there already is kept.
 */
export async function makeDisk(
	path: string,
	setup: NvxSetup,
	base: string,
	proxyPort: number,
	start?: (program: string, words: string[], launch: StartOptions) => Spawned,
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
					"lazy_itable_init=1,lazy_journal_init=1,nodiscard",
					"/out/disk.ext4",
				],
				cwd: "/tmp",
				memoryMib: 512,
				processors: 1,
				hostname: "chopin-disk",
			},
			setup,
			base,
			start,
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

/** Fetches `url` into `path`. */
export async function fetchTo(url: string, path: string) {
	let response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Couldn't download ${url} (${response.status}).`);
	}
	await Bun.write(path, response);
}

/** The guest starts nothing but `nvx`'s own command line, with the environment in a private file. */
function startNvx(program: string, words: string[], launch: StartOptions): Spawned {
	let [command, args] = process.platform === "win32"
		? [program, words]
		: ["/bin/sh", ["-c", launch.open ? OPEN_NVX_LAUNCHER : NVX_LAUNCHER, program, ...words]];
	let child = spawn(command, args, {
		stdio: [launch.stdin, "pipe", "pipe"],
		// Its own process group, with OpenVMM in it, so ending the launch ends the microVM.
		detached: process.platform !== "win32",
		windowsHide: true,
	}) as Spawned;
	Object.defineProperty(child, "stdout", { value: withoutLaunchLine(child.stdout) });
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
	// Before anything is started that would have to be stopped again were it to fail.
	let bridge = await guestBridge(directory);
	let aiRelay = startAiRelay();
	let hosts = [...allowedHosts(options.server, settings.hosts), aiRelay.host];
	let proxy: Proxy = await startProxy({
		hosts,
		refused: (name, port) => options.refused?.(name, port),
	});
	let start = options.start ?? startNvx;
	let images = new Map<string, AgentImage>();
	try {
		for (let [program, recipe] of options.recipes) {
			images.set(
				program,
				await ensureImage(recipe, {
					base: directory,
					layer: setup.artifacts.layer,
					user: guestUser(),
					run: spec => runVm(spec, setup, directory, start),
					download: options.download ?? fetchTo,
					proxyPort: proxy.port,
					...options.building ? { building: options.building } : {},
				}),
			);
		}
		await pruneImages(
			directory,
			[...images.values()].map(image => basename(image.layer.path, ".erofs")),
		);
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
			return startVm(spec, setup, directory, launch.stdin, start, options.wedged);
		},
		aiRelay,
		bridge: guestBridgeCommand(),
		work: GUEST_WORK,
		makeDisk: path => makeDisk(path, setup, directory, proxy.port, start),
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
