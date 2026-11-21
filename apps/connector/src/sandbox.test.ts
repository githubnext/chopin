import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRefused, type VmSpec } from "./nvx";
import { endOrphans, startVm } from "./sandbox";
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
	expect(() => startVm(spec, { artifacts, hypervisor: "whp" }, base, "pipe", refuse))
		.toThrow(SandboxRefused);
	expect(readdirSync(join(base, "nvx", "launches"))).toEqual([]);
});
