import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageBuilder, ImageRecipe } from "./images";
import { type NvxArtifacts, SandboxRefused, STARTED_LINE, type VmSpec } from "./nvx";
import {
	createSandbox,
	endOrphans,
	nvxTemporary,
	runFolderOf,
	type Spawned,
	type StartOptions,
	startVm,
	sweepRunFolders,
} from "./sandbox";
import { processStart } from "./workspace";

let scratch = mkdtempSync(join(tmpdir(), "chopin-orphans-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A process in a group of its own, as `nvx` runs, and whether it is still alive. */
function detached() {
	let child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	let gone = new Promise(resolve => child.once("exit", resolve));
	return {
		pid: child.pid!,
		alive: () => child.exitCode === null && child.signalCode === null,
		stop: async () => {
			child.kill("SIGKILL");
			await gone;
		},
	};
}

function record(base: string, name: string, launch: Record<string, unknown>) {
	let folder = join(base, "nvx", "launches", name);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "launch.json"), JSON.stringify(launch));
	return folder;
}

test.skipIf(process.platform !== "linux")(
	"a dead connector's microVM is ended only while it is still the process recorded, never one that took its number",
	async () => {
		let base = mkdtempSync(join(scratch, "state-"));
		let stranger = detached();
		let orphan = detached();
		try {
			let start = (await processStart()(orphan.pid))!.id;
			// A number now another process's, with no start recorded or another start.
			let reused = record(base, "reused", { pid: stranger.pid, owner: 999_999_999 });
			let restarted = record(base, "restarted", {
				pid: stranger.pid,
				start: "1",
				owner: 999_999_999,
			});
			let left = record(base, "left", { pid: orphan.pid, start, owner: 999_999_999 });
			await endOrphans(base);
			await Bun.sleep(200);
			expect(stranger.alive()).toBe(true);
			expect(orphan.alive()).toBe(false);
			for (let folder of [reused, restarted, left]) expect(existsSync(folder)).toBe(false);
		} finally {
			await stranger.stop();
			await orphan.stop().catch(() => {});
		}
	},
);

test.skipIf(process.platform !== "linux")(
	"a launch of a chopin still running beside this one is left alone",
	async () => {
		let base = mkdtempSync(join(scratch, "state-"));
		let launch = detached();
		let owner = detached();
		try {
			let ownerStart = (await processStart()(owner.pid))!.id;
			let start = (await processStart()(launch.pid))!.id;
			let kept = record(base, "kept", { pid: launch.pid, start, owner: owner.pid, ownerStart });
			await endOrphans(base);
			expect(launch.alive()).toBe(true);
			expect(existsSync(kept)).toBe(true);
		} finally {
			await launch.stop();
			await owner.stop();
		}
	},
);

test("a launch that never starts leaves nothing of its environment, its tokens, behind", () => {
	let base = mkdtempSync(join(scratch, "state-"));
	let spec: VmSpec = {
		shares: [],
		proxyPort: 1,
		environment: { CHOPIN_TOKEN: "secret" },
		command: ["agent"],
		cwd: "/work",
		memoryMib: 256,
		processors: 1,
		hostname: "launch",
	};
	let artifacts = {
		root: base,
		nvx: join(base, "nvx.exe"),
		layer: {
			path: join(base, "ubuntu-distro.erofs"),
			uuid: "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12),
		},
	};
	// As on Windows when its kill-on-close job object can't be made.
	let refuse = () => {
		throw new SandboxRefused("Not run: Windows couldn't make the job that ends this microVM.");
	};
	expect(() => startVm(spec, { artifacts, hypervisor: "whp" }, base, "pipe", { start: refuse }))
		.toThrow(SandboxRefused);
	expect(readdirSync(join(base, "nvx", "launches"))).toEqual([]);
});

const SPEC: VmSpec = {
	shares: [],
	proxyPort: 1,
	environment: {},
	command: ["agent"],
	cwd: "/work",
	memoryMib: 256,
	processors: 1,
	hostname: "launch",
};
const ARTIFACTS: NvxArtifacts = {
	root: "/nvx",
	nvx: "/nvx/bin/nvx",
	layer: {
		path: "/nvx/guest/ubuntu-distro.erofs",
		uuid: `${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`,
	},
};

/** What OpenVMM's log ends with when it couldn't set up a disk, as it said under heavy load. */
const IO_URING_LOG = [
	'   0.012444448s  INFO worker_new{ name="VmWorker" action="new"}: time ABI rates declared',
	"fatal error: failed to launch vm worker",
	"",
	"Caused by:",
	"    0: failed to launch worker",
	"    1: failed to resolve resource of type virtio:virtio-blk",
	"    2: failed to resolve resource of type disk_handle:block",
	"    3: failed to create new device",
	"    4: driver does not support io-uring",
	"",
].join("\n");
/** What OpenVMM's log ends with when its user may no longer open /dev/kvm, as it said. */
const KVM_LOG = [
	'   0.000766448s  INFO openvmm_entry:  version="0.5.0+g51e9af75d"',
	"fatal error: KVM is not available",
	"",
	"Caused by:",
	"    failed to open file `/dev/kvm`: Permission denied (os error 13)",
	"",
].join("\n");
/** What OpenVMM's log ends with when it can't have the guest's memory. */
const MEMORY_LOG = [
	'   0.000766448s  INFO openvmm_entry:  version="0.5.0+g51e9af75d"',
	"fatal error: failed to launch vm worker",
	"",
	"Caused by:",
	"    0: failed to allocate guest memory",
	"",
].join("\n");
const NVX_FAILED = "error[exited]: OpenVMM exited during startup: vmm-failure status 1";

/**
 * A stand-in for `nvx sandbox run`, as it behaves: it keeps a folder of its own in the temporary
 * directory with OpenVMM's log in it, prints the OpenVMM command line naming it, and then, as
 * `mode` says, fails to start (removing its folder, as `nvx` does) or runs a workload, which says it
 * starts as the guest does and records each start in `starts`.
 */
const FAKE_NVX = `
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
let [mode, temporary, delay, starts] = process.argv.slice(2);
await Bun.sleep(Number(delay));
let folder = join(temporary, "nvx-sandbox-run-" + randomBytes(16).toString("hex"));
mkdirSync(folder, { mode: 0o700 });
let log = join(folder, "openvmm.log");
writeFileSync(log, "   0.000766448s  INFO openvmm_entry:  version=\\"0.5.0\\"\\n");
process.stdout.write(">> /nvx/bin/openvmm --machine microvm --microvm-report " + folder + "/outcome.json --guest-shutdown-action exit\\n");
// As OpenVMM gets to its disks, after the connector has had the launch line.
await Bun.sleep(100);
let fail = (text) => {
	writeFileSync(log, text, { flag: "a" });
	rmSync(folder, { recursive: true, force: true });
	process.stderr.write(${JSON.stringify(NVX_FAILED)} + "\\n");
	process.exit(1);
};
if (mode === "uring") fail(${JSON.stringify(IO_URING_LOG)});
if (mode === "kvm") fail(${JSON.stringify(KVM_LOG)});
if (mode === "memory") fail(${JSON.stringify(MEMORY_LOG)});
appendFileSync(starts, "started\\n");
process.stdout.write(${JSON.stringify(STARTED_LINE)} + "\\n");
if (mode === "started-then-uring") {
	process.stdout.write("working\\n");
	fail(${JSON.stringify(IO_URING_LOG)});
}
if (mode === "hang") {
	process.stdout.write("up\\n");
	await new Promise(() => {});
}
let input = await new Response(Bun.stdin.stream()).text();
process.stdout.write("the workload read: " + input);
rmSync(folder, { recursive: true, force: true });
`;

/** A connector's state directory, a temporary directory for `nvx`, and `nvx` itself. */
function machine(modes: string[]) {
	let base = mkdtempSync(join(scratch, "state-"));
	let temporary = mkdtempSync(join(scratch, "tmp-"));
	let script = join(base, "fake-nvx.mjs");
	let starts = join(base, "starts");
	writeFileSync(script, FAKE_NVX);
	writeFileSync(starts, "");
	let calls: StartOptions[] = [];
	let start = (_program: string, _words: string[], launch: StartOptions) => {
		let mode = modes[calls.length] ?? modes.at(-1)!;
		calls.push(launch);
		return spawn(
			process.execPath,
			[script, mode, temporary, String(launch.delayMs ?? 0), starts],
			{ stdio: [launch.stdin, "pipe", "pipe"], detached: true },
		) as Spawned;
	};
	return {
		base,
		temporary,
		calls,
		start,
		starts: () => readFileSync(starts, "utf8").split("\n").filter(Boolean).length,
		launches: () => readdirSync(join(base, "nvx", "launches")),
	};
}

/** How a launch ended, and what it wrote. */
function ended(child: Spawned) {
	let out = "";
	let err = "";
	child.stdout.on("data", chunk => out += chunk);
	child.stderr.on("data", chunk => err += chunk);
	return new Promise<{ code: number | null; signal: string | null; out: string; err: string }>(
		resolve => child.once("close", (code, signal) => resolve({ code, signal, out, err })),
	);
}

const SETUP = { artifacts: ARTIFACTS, hypervisor: "kvm" as const };

describe.skipIf(process.platform === "win32")("starting a launch's microVM", () => {
	test(
		"a start OpenVMM failed with io-uring starts again, and the workload starts and reads its input once",
		async () => {
			let vm = machine(["uring", "run"]);
			let retrying: string[] = [];
			let child = startVm(SPEC, SETUP, vm.base, "pipe", {
				start: vm.start,
				retrying: detail => retrying.push(detail),
			});
			// Written before any start: the workload that starts reads it, and the start that failed doesn't.
			child.stdin!.write("hello\n");
			child.stdin!.end();
			expect(await ended(child)).toEqual({
				code: 0,
				signal: null,
				out: "the workload read: hello\n",
				err: "",
			});
			expect(vm.calls.map(call => call.delayMs ?? 0)).toEqual([0, 500]);
			expect(vm.starts()).toBe(1);
			expect(retrying).toEqual([
				"A microVM didn't start (OpenVMM: driver does not support io-uring), so chopin starts it again (2 of 3).",
			]);
			expect(readdirSync(vm.temporary)).toEqual([]);
			expect(vm.launches()).toEqual([]);
		},
		20_000,
	);

	test(
		"another failure to start is not tried again, and says the end of OpenVMM's log",
		async () => {
			let vm = machine(["memory", "run"]);
			let unsupported: unknown[] = [];
			let child = startVm(SPEC, SETUP, vm.base, "ignore", {
				start: vm.start,
				unsupported: problem => unsupported.push(problem),
			});
			expect(await ended(child)).toEqual({
				code: 1,
				signal: null,
				out: "",
				err: "The microVM didn't start: fatal error: failed to launch vm worker / Caused by: / 0: "
					+ "failed to allocate guest memory (nvx: " + NVX_FAILED + ")\n",
			});
			expect(vm.calls).toHaveLength(1);
			expect(vm.starts()).toBe(0);
			expect(unsupported).toEqual([]);
		},
		20_000,
	);

	test(
		"a start OpenVMM couldn't open /dev/kvm for says this machine can't run microVMs, with the fix, and tells whoever started it",
		async () => {
			let vm = machine(["kvm", "run"]);
			let unsupported: unknown[] = [];
			let words: string[] = [];
			let child = startVm(SPEC, SETUP, vm.base, "ignore", {
				start: vm.start,
				// Its user joined the kvm group after the service's user manager began.
				host: { joinedLater: path => path === "/dev/kvm" },
				unsupported: problem => {
					unsupported.push(problem);
					// Heard before the launch ends, so nothing starts again meanwhile.
					words.push(child.exitCode === null ? "before its end" : "after its end");
				},
			});
			let reason = "Your user is in the kvm group, but chopin runs in a login that began before "
				+ "you joined it, so it can't read and write /dev/kvm yet.";
			let fix = "Log out and back in (for the chopin service, restart the machine). Or have an "
				+ 'administrator add a udev rule, such as KERNEL=="kvm", GROUP="kvm", MODE="0660", '
				+ 'RUN+="/usr/bin/setfacl -m u:<user>:rw /dev/kvm" (logind may drop that ACL)';
			expect(await ended(child)).toEqual({
				code: 1,
				signal: null,
				out: "",
				err: "This machine can't run Chopin's work: Chopin runs each agent in its own microVM, "
					+ `which needs Linux or Windows on x86_64 with hardware virtualization. ${reason} `
					+ `Fix: ${fix} (OpenVMM: failed to open file \`/dev/kvm\`: Permission denied (os `
					+ "error 13))\n",
			});
			expect(unsupported).toEqual([{ supported: false, reason, fix }]);
			expect(words).toEqual(["before its end"]);
			expect(vm.calls).toHaveLength(1);
			expect(vm.starts()).toBe(0);
			expect(vm.launches()).toEqual([]);
		},
		20_000,
	);

	test("a start whose workload had started is never tried again", async () => {
		let vm = machine(["started-then-uring", "run"]);
		let child = startVm(SPEC, SETUP, vm.base, "pipe", { start: vm.start });
		expect(await ended(child)).toEqual({
			code: 1,
			signal: null,
			out: "working\n",
			err: `${NVX_FAILED}\n`,
		});
		expect(vm.calls).toHaveLength(1);
		expect(vm.starts()).toBe(1);
	}, 20_000);

	test("three failed starts end the launch, saying why", async () => {
		let vm = machine(["uring"]);
		let child = startVm(SPEC, SETUP, vm.base, "ignore", { start: vm.start });
		expect(await ended(child)).toEqual({
			code: 1,
			signal: null,
			out: "",
			err: "The microVM didn't start after 3 tries: fatal error: failed to launch vm worker / "
				+ "Caused by: / 0: failed to launch worker / 1: failed to resolve resource of type "
				+ "virtio:virtio-blk / 2: failed to resolve resource of type disk_handle:block / 3: failed "
				+ "to create new device / 4: driver does not support io-uring (nvx: " + NVX_FAILED + ")\n",
		});
		expect(vm.calls.map(call => call.delayMs ?? 0)).toEqual([0, 500, 1_500]);
		expect(readdirSync(vm.temporary)).toEqual([]);
		expect(vm.launches()).toEqual([]);
	}, 20_000);

	test("a launch stopped while it waits to start again ends without starting", async () => {
		let vm = machine(["uring", "run"]);
		let child = startVm(SPEC, SETUP, vm.base, "pipe", {
			start: vm.start,
			// As a caller ends a launch: its process group, which is the waiting start's.
			retrying: () => setTimeout(() => process.kill(-child.pid!, "SIGTERM"), 100),
		});
		let result = await ended(child);
		expect({ code: result.code, signal: result.signal }).toEqual({ code: null, signal: "SIGTERM" });
		expect(vm.calls).toHaveLength(2);
		expect(vm.starts()).toBe(0);
		expect(vm.launches()).toEqual([]);
	}, 20_000);

	test("a launch ended by force leaves nothing of nvx's in the temporary directory", async () => {
		let vm = machine(["hang"]);
		let child = startVm(SPEC, SETUP, vm.base, "ignore", { start: vm.start });
		let result = ended(child);
		await new Promise(resolve => child.stdout.once("data", resolve));
		let [run] = readdirSync(vm.temporary);
		let record = JSON.parse(
			readFileSync(join(vm.base, "nvx", "launches", vm.launches()[0]!, "launch.json"), "utf8"),
		);
		expect(record.run).toBe(join(vm.temporary, run!));
		process.kill(-child.pid!, "SIGKILL");
		expect((await result).signal).toBe("SIGKILL");
		expect(readdirSync(vm.temporary)).toEqual([]);
		expect(vm.launches()).toEqual([]);
	}, 20_000);
});

test("nvx's folder is read from the OpenVMM command line it prints, on Linux and Windows", () => {
	expect(
		runFolderOf(
			">> /nvx/bin/openvmm --machine microvm --microvm-control-console listen=/tmp/nvx-sandbox-run-5821597868702c8d/control.sock --microvm-report /tmp/nvx-sandbox-run-5821597868702c8d/outcome.json --guest-shutdown-action exit",
			"linux",
		),
	).toBe("/tmp/nvx-sandbox-run-5821597868702c8d");
	expect(
		runFolderOf(
			">> C:\\nvx\\bin\\openvmm.exe --microvm-control-console listen=//./pipe/openvmm-microvm-a23d --microvm-report C:\\Users\\mona\\AppData\\Local\\Temp\\nvx-sandbox-run-7158f3d7\\outcome.json --guest-shutdown-action exit",
			"win32",
		),
	).toBe("C:\\Users\\mona\\AppData\\Local\\Temp\\nvx-sandbox-run-7158f3d7");
	expect(
		runFolderOf(
			'>> "C:\\nvx\\bin\\openvmm.exe" --microvm-report "C:\\Users\\Mona Lisa\\AppData\\Local\\Temp\\nvx-sandbox-run-7158f3d7\\outcome.json"',
			"win32",
		),
	).toBe("C:\\Users\\Mona Lisa\\AppData\\Local\\Temp\\nvx-sandbox-run-7158f3d7");
	// Only a folder of nvx's own is ever taken for one.
	expect(runFolderOf(">> openvmm --microvm-report /home/mona/outcome.json", "linux"))
		.toBeUndefined();
	expect(runFolderOf(">> openvmm --machine microvm", "linux")).toBeUndefined();
});

test("nvx's folders are looked for where nvx makes them, which on Linux only TMPDIR moves", () => {
	expect(nvxTemporary({ TMP: "/fast/tmp", TEMP: "/fast/tmp" }, "linux")).toBe("/tmp");
	expect(nvxTemporary({ TMPDIR: "/fast/tmp", TMP: "/elsewhere" }, "linux")).toBe("/fast/tmp");
	expect(nvxTemporary({ TMP: "C:\\Temp", TEMP: "C:\\Users\\mona\\Temp" }, "win32")).toBe(
		"C:\\Temp",
	);
	expect(nvxTemporary({ TEMP: "C:\\Users\\mona\\Temp" }, "win32")).toBe("C:\\Users\\mona\\Temp");
});

describe.skipIf(process.platform !== "linux")(
	"nvx's folders a connector sweeps as it starts",
	() => {
		/** A folder of nvx's in `temporary`, made `ageMs` ago. */
		function runFolder(temporary: string, name: string, ageMs = 120_000) {
			let folder = join(temporary, `nvx-sandbox-run-${name}`);
			mkdirSync(folder);
			writeFileSync(join(folder, "openvmm.log"), "log\n");
			let then = new Date(Date.now() - ageMs);
			utimesSync(folder, then, then);
			return folder;
		}

		test("one no launch or process has is removed", async () => {
			let base = mkdtempSync(join(scratch, "state-"));
			let temporary = mkdtempSync(join(scratch, "tmp-"));
			let stale = runFolder(temporary, "0a");
			let other = join(temporary, "chopin-other");
			mkdirSync(other);
			await sweepRunFolders(base, temporary);
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(other)).toBe(true);
		});

		test("a live launch's survives a sweep by another connector, on this base dir or another", async () => {
			let base = mkdtempSync(join(scratch, "state-"));
			let elsewhere = mkdtempSync(join(scratch, "state-"));
			let temporary = mkdtempSync(join(scratch, "tmp-"));
			let launch = detached();
			let owner = detached();
			let recorded = runFolder(temporary, "1b");
			let running = runFolder(temporary, "2c");
			let starting = runFolder(temporary, "3d", 1_000);
			// OpenVMM names its folder on its command line for as long as it runs.
			let openvmm = spawn(
				"sh",
				["-c", "sleep 60", "openvmm", `--microvm-report=${running}/outcome.json`],
				{ detached: true, stdio: "ignore" },
			);
			try {
				let ownerStart = (await processStart()(owner.pid))!.id;
				let start = (await processStart()(launch.pid))!.id;
				// A chopin beside this one on its base dir, whose launch's record names its folder.
				record(base, "live", {
					pid: launch.pid,
					start,
					owner: owner.pid,
					ownerStart,
					run: recorded,
				});
				await endOrphans(base);
				await sweepRunFolders(base, temporary);
				for (let folder of [recorded, running, starting]) expect(existsSync(folder)).toBe(true);
				// A chopin on another base dir has no record of either, and finds the running one's process.
				await endOrphans(elsewhere);
				await sweepRunFolders(elsewhere, temporary);
				for (let folder of [running, starting]) expect(existsSync(folder)).toBe(true);
			} finally {
				openvmm.kill("SIGKILL");
				await launch.stop();
				await owner.stop();
			}
		});

		test("a dead connector's launch takes nvx's folder with its record", async () => {
			let base = mkdtempSync(join(scratch, "state-"));
			let temporary = mkdtempSync(join(scratch, "tmp-"));
			let run = runFolder(temporary, "4e", 0);
			let left = record(base, "left", { pid: 999_999_999, owner: 999_999_999, run });
			await endOrphans(base);
			expect(existsSync(run)).toBe(false);
			expect(existsSync(left)).toBe(false);
		});
	},
);

/**
 * A builder that stands in for the build's microVM, counting its builds: the first is made at once,
 * as connect makes it; each after it waits for `release`, and fails with `failure` when one is set.
 */
function heldBuilder(failure?: string) {
	let builds = 0;
	let gate = Promise.withResolvers<void>();
	let builder: ImageBuilder = {
		async build(_recipe, job) {
			builds++;
			if (builds > 1) await gate.promise;
			if (failure && builds > 1) throw new Error(failure);
			writeFileSync(job.layer, "layer");
		},
		missing: async () => [],
	};
	return { builder, builds: () => builds, release: gate.resolve };
}

const PLANNER: ImageRecipe = {
	name: "my-planner",
	install: ["npm install -g my-planner"],
	programs: ["my-planner"],
	runs: ["planner"],
};

describe.skipIf(process.platform === "win32")("a burst of launches whose image is gone", () => {
	async function machineWith(builder: ImageBuilder) {
		let vm = machine(["run"]);
		let sandbox = await createSandbox({
			directory: vm.base,
			server: "http://127.0.0.1:9",
			setup: SETUP,
			recipes: new Map([["my-planner", PLANNER]]),
			start: vm.start,
			builder,
		});
		// Gone since connect made it, as when someone removed it.
		rmSync(join(vm.base, "images"), { recursive: true, force: true });
		let folder = join(vm.base, "documents");
		mkdirSync(folder);
		let launch = () =>
			sandbox.spawn({ command: ["my-planner"], cwd: folder, env: {}, stdin: "ignore" });
		return { vm, sandbox, launch };
	}

	test(
		"ten Planner launches at once wait on one build, and each starts in the image it made",
		async () => {
			let images = heldBuilder();
			let { vm, sandbox, launch } = await machineWith(images.builder);
			try {
				let launches = Array.from({ length: 10 }, launch);
				let ends = Promise.all(launches.map(ended));
				await Bun.sleep(200);
				// One build since connect's, under way, and nothing started before it is done.
				expect(images.builds()).toBe(2);
				expect(vm.calls).toHaveLength(0);
				images.release();
				expect((await ends).map(end => [end.code, end.out])).toEqual(
					Array(10).fill([0, "the workload read: "]),
				);
				expect(images.builds()).toBe(2);
				expect(vm.starts()).toBe(10);
			} finally {
				await sandbox.close();
			}
		},
		30_000,
	);

	test(
		"a build that fails ends every launch waiting on it with its words, and starts none",
		async () => {
			let words = "Couldn't build my-planner's image (exit 1):\nnpm error 404 my-planner";
			let images = heldBuilder(words);
			let { vm, sandbox, launch } = await machineWith(images.builder);
			try {
				let launches = Array.from({ length: 10 }, launch);
				let ends = Promise.all(launches.map(ended));
				images.release();
				expect((await ends).map(end => [end.code, end.err])).toEqual(
					Array(10).fill([1, `${words}\n`]),
				);
				expect(images.builds()).toBe(2);
				expect(vm.calls).toHaveLength(0);
			} finally {
				await sandbox.close();
			}
		},
		30_000,
	);

	test(
		"a spare's boot waits on the one build with the documents' launches, never builds again, and each says its workload started",
		async () => {
			let images = heldBuilder();
			let { vm, sandbox, launch } = await machineWith(images.builder);
			try {
				let folder = join(vm.base, "spare");
				mkdirSync(folder);
				// A spare is a launch like any other: the same image, its stdin kept for its hand-over.
				let spare = sandbox.spawn({
					command: ["my-planner"],
					cwd: folder,
					env: { CHOPIN_PLANNER_SPARE: "1" },
					stdin: "pipe",
				});
				let launches = [spare, launch(), launch(), launch()];
				let workloads = launches.map(child =>
					new Promise<boolean>(resolve => child.once("workload", () => resolve(true)))
				);
				let ends = Promise.all(launches.map(ended));
				spare.stdin?.end();
				await Bun.sleep(200);
				expect(images.builds()).toBe(2);
				expect(vm.calls).toHaveLength(0);
				images.release();
				// Each hears its workload start, as the launch gate does to give its slot back.
				expect(await Promise.all(workloads)).toEqual([true, true, true, true]);
				await ends;
				expect(images.builds()).toBe(2);
				expect(vm.starts()).toBe(4);
			} finally {
				await sandbox.close();
			}
		},
		30_000,
	);

	test("a launch stopped while it waits for the image starts nothing", async () => {
		let images = heldBuilder();
		let { vm, sandbox, launch } = await machineWith(images.builder);
		try {
			let stopped = launch();
			let other = launch();
			let ends = Promise.all([ended(stopped), ended(other)]);
			stopped.kill("SIGTERM");
			images.release();
			let [first, second] = await ends;
			expect([first.code, first.signal]).toEqual([null, "SIGTERM"]);
			expect([second.code, second.out]).toEqual([0, "the workload read: "]);
			expect(vm.starts()).toBe(1);
		} finally {
			await sandbox.close();
		}
	}, 30_000);
});
