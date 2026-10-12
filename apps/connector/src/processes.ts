import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";
import { sep } from "node:path";
import { promisify } from "node:util";

/**
 * Processes whose working directory is inside `directory`. An agent's tools often start servers in
 * their own process group (`vite &`), and those are reparented once the tool's shell exits, so
 * neither the agent's group nor its process tree still reaches them. The run's worktree does.
 * Only processes without a controlling terminal count.
 */
export async function processesIn(directory: string): Promise<number[]> {
	// lsof reports resolved paths (macOS temp directories live under /private).
	directory = await realpath(directory).catch(() => directory);
	let inside = (path: string) => path === directory || path.startsWith(directory + sep);
	let found: number[] = [];
	if (process.platform === "linux") {
		for (let entry of await readdir("/proc").catch(() => [])) {
			if (!/^\d+$/.test(entry)) continue;
			let cwd = await readlink(`/proc/${entry}/cwd`).catch(() => "");
			if (cwd && inside(cwd)) found.push(Number(entry));
		}
	} else {
		// lsof exits non-zero when some processes can't be inspected; its output is still complete.
		let { stdout } = await promisify(execFile)("lsof", ["-a", "-d", "cwd", "-F", "pn"], {
			maxBuffer: 16 * 1024 * 1024,
		}).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
		let pid = 0;
		for (let line of stdout.split("\n")) {
			if (line.startsWith("p")) pid = Number(line.slice(1));
			else if (line.startsWith("n") && pid && inside(line.slice(1))) found.push(pid);
		}
	}
	let pids = [...new Set(found)].filter(pid => pid !== process.pid);
	if (!pids.length) return [];
	// The agent runs in its own session, so what it starts has no terminal. A person's shell that
	// opened the worktree to inspect it does, and is left alone.
	let { stdout: ttys } = await promisify(execFile)("ps", ["-o", "pid=,tty=", "-p", pids.join(",")])
		.catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
	return ttys.split("\n").flatMap(line => {
		let [pid, tty] = line.trim().split(/\s+/);
		return pid && (tty === "?" || tty === "??") ? [Number(pid)] : [];
	});
}

/** Stop everything still running in a finished run's worktree: SIGTERM, then SIGKILL survivors. */
export async function stopProcessesIn(directory: string, graceMs = 1000): Promise<number[]> {
	let pids = await processesIn(directory);
	let signal = (pid: number, name: NodeJS.Signals) => {
		try {
			process.kill(pid, name);
			return true;
		} catch {
			return false;
		}
	};
	let alive = pids.filter(pid => signal(pid, "SIGTERM"));
	let deadline = Date.now() + graceMs;
	while (alive.length && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 50));
		alive = alive.filter(pid => signal(pid, 0 as unknown as NodeJS.Signals));
	}
	for (let pid of alive) signal(pid, "SIGKILL");
	return pids;
}
