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

import { dirname, join } from "node:path";
import manifest from "../package.json";
import { discoverExeDev, parseDevTarget } from "./dev-options";

import type { Subprocess } from "bun";

const ROOT = dirname(import.meta.dir);

if (`bun@${Bun.version}` !== manifest.packageManager) {
	console.error(`[dev] ${manifest.packageManager} is required; found bun@${Bun.version}`);
	process.exit(1);
}

/** How long a child gets to leave politely before it is made to. */
const GRACE_MS = 2_000;

const WEB = "http://127.0.0.1:5173";

async function exeDevelopment() {
	try {
		return parseDevTarget(process.argv.slice(2)) === "exe" ? await discoverExeDev() : undefined;
	} catch (error) {
		console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

let exe = await exeDevelopment();

/** Local defaults kept in step with `apps/server/src/config.ts`. */
const APP = exe?.origin
	?? `http://${process.env.SERVER_HOST || "127.0.0.1"}:${process.env.PORT || 8787}`;
const READY = exe ? "http://127.0.0.1:8787" : APP;
const HMR = exe ? `wss://${exe.host}:5173` : undefined;

const READY_MS = 30_000;

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
 * Print where the app is, once it answers.
 *
 * Vite prints its own address, which does not work — the server is the only
 * origin. Waiting for a reply puts this line below Vite's banner, and the
 * server 502s until Vite is up, so a reply means both halves are ready.
 */
async function announce(): Promise<void> {
	let deadline = Date.now() + READY_MS;

	while (Date.now() < deadline) {
		if (stopping) return;

		try {
			let response = await fetch(READY, { redirect: "manual" });
			await response.body?.cancel();
			if (response.ok) {
				console.log(`\n[dev] chopin is at ${APP}`);
				if (HMR) console.log(`[dev] vite hmr is at ${HMR} (private alternate port)`);
				console.log();
				return;
			}
		} catch {}

		await Bun.sleep(250);
	}
}

children = [
	// Vite's own entry, run by Bun. Going through `bun run dev` would add the
	// wrapper described above, and the shim in `.bin` carries a Node shebang —
	// which is one more thing that has to be installed for no benefit.
	start("web", "apps/web", ["bun", "node_modules/vite/bin/vite.js"], {
		APP_ORIGIN: exe?.origin ?? process.env.APP_ORIGIN ?? "",
		CHOPIN_DEV_EXE_HOST: exe?.host ?? "",
	}),
	start("server", "apps/server", ["bun", "--watch", "src/main.ts"], {
		DEV_CLIENT: WEB,
		...(exe
			? {
				APP_ORIGIN: exe.origin,
				SERVER_HOST: "0.0.0.0",
				PORT: "8787",
			}
			: {}),
	}),
];

for (let name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(name, () => void stop(0));
}

void announce();

// A supervisor that outlived its children would leave the terminal looking
// busy with nothing behind it.
await new Promise(() => {});
