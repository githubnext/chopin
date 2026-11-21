import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killJob, sparseFile, unhide } from "./windows-host";

/** What Windows' own tools say, for checks only Windows can make. */
let windows = process.platform === "win32";
let scratch = mkdtempSync(join(tmpdir(), "chopin-windows-host-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test.skipIf(!windows)(
	"a disk's file is made sparse on the host, its whole size and nothing written",
	() => {
		let path = join(scratch, "disk.ext4");
		sparseFile(path, 32 * 1024 ** 3);
		expect(statSync(path).size).toBe(32 * 1024 ** 3);
		let flag = spawnSync("fsutil", ["sparse", "queryflag", path], { encoding: "utf8" }).stdout;
		expect(flag).toContain("is set as sparse");
	},
);

test.skipIf(!windows)(
	"a checkout's hidden .git is shown again, and one already shown is left as it is",
	() => {
		let git = join(scratch, "checkout", ".git");
		mkdirSync(git, { recursive: true });
		spawnSync("attrib", ["+h", git]);
		let hidden = () => /^\s*\S*H/.test(spawnSync("attrib", [git], { encoding: "utf8" }).stdout);
		expect(hidden()).toBe(true);
		expect(unhide(git)).toBe(true);
		expect(hidden()).toBe(false);
		expect(unhide(git)).toBe(true);
		expect(unhide(join(scratch, "missing"))).toBe(false);
	},
);

test.skipIf(!windows)(
	"killing a launch's job ends its process and what that process started",
	async () => {
		// A process that starts another and outlives nothing, as nvx.exe starts OpenVMM.
		let parent = spawn(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -PassThru -WindowStyle Hidden; Start-Sleep -Seconds 120",
			],
			{ stdio: "ignore", windowsHide: true },
		);
		let job = killJob(parent.pid!)!;
		expect(job).toBeDefined();
		await Bun.sleep(1500);
		// It and what it started (Windows adds a console host to each).
		expect(job.active()).toBeGreaterThanOrEqual(2);
		job.kill();
		for (let wait = 0; wait < 50 && job.active() > 0; wait++) await Bun.sleep(100);
		expect(job.active()).toBe(0);
		job.close();
	},
);

test.skipIf(windows)("off Windows there is no job, and nothing is hidden", () => {
	expect(killJob(process.pid)).toBeUndefined();
	expect(unhide(scratch)).toBe(true);
});
