import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endOrphans } from "./sandbox";
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
