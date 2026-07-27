#!/usr/bin/env bun
/**
 * Development supervisor.
 *
 * Two processes have to run together — Vite building the client, and the server
 * that owns the socket and forwards everything else to it — and they have to
 * stop together too.
 *
 * The obvious shell version, `vite & server`, does not. The backgrounded half
 * ends up in a different process group from the one the terminal signals on
 * Ctrl-C, so stopping the visible process leaves Vite and its esbuild child
 * running, holding a port and several hundred megabytes. The next start then
 * silently talks to whichever of them the OS resolves first.
 *
 * Two things make this reliable. Each child is given its own process group and
 * killed as a group, so nothing beneath it is left behind. And each is spawned
 * directly rather than through `bun run`, because that wrapper does not exit
 * when the thing it started dies — it sits there with no child, and a
 * supervisor watching it would never learn that Vite had gone.
 */

import { dirname, join, resolve } from "node:path";

import type { Subprocess } from "bun";

const ROOT = dirname(import.meta.dir);

/** How long a child gets to leave politely before it is made to. */
const GRACE_MS = 2_000;

const WEB = "http://127.0.0.1:5173";

type Child = { name: string; proc: Subprocess };

let children: Child[] = [];
let stopping = false;

function start(name: string, cwd: string, cmd: string[], env: Record<string, string> = {}): Child {
	let proc = Bun.spawn(cmd, {
		cwd: join(ROOT, cwd),
		env: { ...process.env, ...env },
		stdio: ["inherit", "inherit", "inherit"],
		// Its own process group, so the whole tree beneath it can be taken down
		// by group. Killing the leader alone would leave its children behind,
		// which is the entire problem this exists to solve.
		detached: true,
		onExit(_proc, code, signal) {
			if (stopping) return;
			// One half is useless without the other, and a half-running
			// environment is worse than a stopped one because it looks like it
			// is working.
			console.error(`\n[dev] ${name} exited (${signal ?? code}); stopping the rest.`);
			void stop(code ?? 1);
		},
	});

	return { name, proc };
}

/** Signal a whole process group, tolerating one that has already gone. */
function signal(child: Child, name: NodeJS.Signals): void {
	try {
		// Negative pid addresses the group rather than its leader.
		process.kill(-child.proc.pid, name);
	} catch {
		// Already gone. Nothing to do, and nothing worth saying about it.
	}
}

async function stop(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;

	for (let child of children) signal(child, "SIGTERM");

	// Vite writes its dependency cache on the way out, so it is worth waiting
	// for. Not worth waiting indefinitely.
	let deadline = Date.now() + GRACE_MS;
	while (Date.now() < deadline && children.some(child => !child.proc.killed)) {
		await Bun.sleep(50);
	}

	for (let child of children) {
		if (!child.proc.killed) signal(child, "SIGKILL");
	}

	process.exit(code);
}

/**
 * Settle relative paths here, where the current directory is still yours.
 *
 * Each child is started in its own package directory, so `WORKING_DIR=../thing`
 * would otherwise be resolved against `apps/server` and point at somewhere that
 * does not exist. Resolving before handing it on means a relative path means
 * what it looked like it meant when you typed it.
 */
function inherited(): Record<string, string> {
	let out: Record<string, string> = {};
	for (let name of ["WORKING_DIR", "DATA_DIR"]) {
		let value = process.env[name];
		if (value) out[name] = resolve(value);
	}
	return out;
}

let paths = inherited();

children = [
	// Vite's own entry, run by Bun. Going through `bun run dev` would add the
	// wrapper described above, and the shim in `.bin` carries a Node shebang —
	// which is one more thing that has to be installed for no benefit.
	start("web", "apps/web", ["bun", "node_modules/vite/bin/vite.js"]),
	start("server", "apps/server", ["bun", "--watch", "src/main.ts"], {
		...paths,
		DEV_CLIENT: WEB,
	}),
];

for (let name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(name, () => void stop(0));
}

// A supervisor that outlived its children would leave the terminal looking
// busy with nothing behind it.
await new Promise(() => {});
