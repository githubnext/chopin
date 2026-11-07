/**
 * Where a load run happens: two Chopin processes over one database behind a proxy that holds
 * requests, started and stopped the way a deploy does. Either two processes on this host, or the
 * built image in the two-slot compose project (`deploy/overlap/compose.yaml`); and the reference
 * Caddy as the proxy, or `e2e/holding-proxy.ts`, which does what the reference configuration
 * does, where Caddy or a container cannot be had. Both ask for the fake GitHub of the browser
 * tests, which stands in for GitHub's network and nothing else (`e2e/github.ts`).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SQL } from "bun";

import { startHoldingProxy } from "../../e2e/holding-proxy";
import { composeSlots, run, slotPorts, startProxy, text, until } from "../overlap";

import type { ChildProcess } from "node:child_process";
import type { Options } from "../overlap";

export type Slot = "a" | "b";
export const other = (slot: Slot): Slot => slot === "a" ? "b" : "a";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOAD_COMPOSE = fileURLToPath(
	new URL("../../deploy/overlap/compose.load.yaml", import.meta.url),
);
const HOST = "127.0.0.1";
const KEY = "33".repeat(32);
/** What a deploy gives the old process to stop in, as `stop_grace_period` does in the compose file. */
const STOP_GRACE_MS = 30_000;

export type EnvironmentOptions = {
	mode: "processes" | "compose";
	/** `caddy` is the reference configuration in a container; `holding` is the stand-in. */
	proxy: "caddy" | "holding";
	/** The proxy's port; the slots take the next two, and a compose project's database the one after. */
	port: number;
	/** A database on a disposable cluster, which a host run creates a scratch database on. */
	cluster?: string;
	/** The image a compose run deploys. */
	image?: string;
	turnWaitMs: number;
	unreadyMs: number;
	plannerWindowMs: number;
	keepDatabase: boolean;
};

/** What the slots' servers are told, which the compose override file takes from these variables. */
export function serverEnvironment(
	options: EnvironmentOptions,
	origin: string,
): Record<string, string> {
	return {
		SERVER_HOST: HOST,
		APP_ORIGIN: origin,
		STORAGE_DRIVER: "postgres",
		JEV_API_KEY: "e2e-jev-only",
		GITHUB_APP_SLUG: "chopin-e2e",
		GITHUB_APP_CLIENT_ID: "e2e",
		GITHUB_APP_CLIENT_SECRET: "e2e",
		GITHUB_ALLOWED_USERS: "",
		GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
		SESSION_ENCRYPTION_KEY: KEY,
		AGENT: "on",
		HARNESS: "remote",
		DECISIONS_MODEL: "typesafe/jev-latest",
		BACKGROUND_JOBS: "off",
		WEB_RESEARCH: "off",
		CONVERSATION_PLAN: "off",
		DEV_QUESTIONS: "",
		DEV_COMMENTS: "",
		HANDOVER: "wait",
		HANDOVER_UNREADY_MS: String(options.unreadyMs),
		HANDOVER_PLANNER_WINDOW_MS: String(options.plannerWindowMs),
		HANDOVER_TURN_WAIT_MS: String(options.turnWaitMs),
	};
}

/** What one slot said, kept as lines of the kinds a report reads. */
class SlotLog {
	text = "";
	lines: string[] = [];
	push(chunk: string): void {
		this.text = (this.text + chunk).slice(-200_000);
		for (let line of chunk.split("\n")) {
			if (
				/chopin: (ready|cut finished|\d+ readiness|no readiness|closing|standby|the writer lease)/
					.test(line)
			) {
				this.lines.push(line.trim());
			}
		}
	}
}

export type Environment = {
	origin: string;
	port: number;
	/** The database the slots share, for the run's own reads and for seeding. */
	database: string;
	mode: EnvironmentOptions["mode"];
	proxy: string;
	slotUrl(slot: Slot, path: string): string;
	/** The slot that answers ready, if one does. */
	serving(): Promise<Slot | undefined>;
	/** What the slot says on `live`: `live` while it holds the lease, `standby` while it waits. */
	state(slot: Slot): Promise<string | undefined>;
	/** Starts the slot beside the other. */
	start(slot: Slot): Promise<void>;
	/** SIGTERM to the slot's process; resolves with its exit code once it has gone. */
	stop(slot: Slot): Promise<number | null>;
	/** The processor time the slot's process has used, in seconds, where it is a process on this host. */
	cpuSeconds?(slot: Slot): number | undefined;
	/** What the slot logged: the lines a report reads, then its recent log. */
	log(slot: Slot): Promise<string>;
	close(): Promise<void>;
};

export async function startEnvironment(options: EnvironmentOptions): Promise<Environment> {
	return options.mode === "compose" ? composeEnvironment(options) : processEnvironment(options);
}

async function startProxyFor(options: EnvironmentOptions, upstreams: Record<Slot, number>) {
	return options.proxy === "caddy"
		? {
			name: "the reference Caddy (caddy:2.11-alpine, deploy/overlap/Caddyfile)",
			...await startProxy(options.port, upstreams),
		}
		: {
			name: "the stand-in proxy (e2e/holding-proxy.ts)",
			...await startHoldingProxy(options.port, upstreams),
		};
}

async function processEnvironment(options: EnvironmentOptions): Promise<Environment> {
	if (!options.cluster) throw new Error("--database names a database on a disposable cluster");
	let origin = `http://${HOST}:${options.port}`;
	let ports = slotPorts(options.port);
	let name = `chopin_load_${Date.now().toString(36)}`;
	let cluster = new URL(options.cluster);
	let admin = new SQL(cluster.href);
	await admin.unsafe(`CREATE DATABASE ${name}`);
	let own = new URL(cluster);
	own.pathname = `/${name}`;
	let database = own.href;
	let env = { ...process.env as Record<string, string>, ...serverEnvironment(options, origin) };
	let migrated = await run(process.execPath, ["apps/server/src/storage/migrate.ts"], {
		...env,
		PORT: String(ports.a),
		DATABASE_URL: database,
	});
	if (migrated.code !== 0) throw new Error(`could not migrate the database:\n${migrated.out}`);
	let children = new Map<Slot, { child: ChildProcess; log: SlotLog }>();
	let slots = {
		serving: async () => {
			for (let slot of ["a", "b"] as const) {
				if ((await text(`http://${HOST}:${ports[slot]}/api/health/ready`))?.[0] === 200) {
					return slot;
				}
			}
			return undefined;
		},
		state: async (slot: Slot) => (await text(`http://${HOST}:${ports[slot]}/api/health/live`))?.[1],
		start: async (slot: Slot) => {
			let child = spawn(process.execPath, [
				"--preload",
				"./e2e/github.ts",
				"--preload",
				"./e2e/jev.ts",
				"apps/server/src/main.ts",
			], {
				cwd: ROOT,
				detached: true,
				env: { ...env, PORT: String(ports[slot]), DATABASE_URL: database },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let log = new SlotLog();
			child.stdout?.on("data", chunk => log.push(String(chunk)));
			child.stderr?.on("data", chunk => log.push(String(chunk)));
			children.set(slot, { child, log });
		},
		stop: async (slot: Slot) => {
			let held = children.get(slot)?.child;
			if (!held) return null;
			if (held.exitCode !== null || held.pid === undefined) return held.exitCode;
			let exit = new Promise<number | null>(resolve => held.once("close", code => resolve(code)));
			process.kill(-held.pid, "SIGTERM");
			// A platform stops a container that outlasts its grace; so does this one, and it is a failure.
			let killer = setTimeout(() => process.kill(-held.pid!, "SIGKILL"), STOP_GRACE_MS);
			return exit.finally(() => clearTimeout(killer));
		},
	};
	await slots.start("a");
	await until("slot a to be ready", async () => {
		let held = children.get("a")!;
		if (held.child.exitCode !== null) {
			throw new Error(`slot a exited:\n${held.log.text.slice(-1500)}`);
		}
		return (await slots.serving()) === "a";
	});
	let proxy = await startProxyFor(options, ports);
	return {
		origin,
		port: options.port,
		database,
		mode: "processes",
		proxy: proxy.name,
		slotUrl: (slot, path) => `http://${HOST}:${ports[slot]}${path}`,
		...slots,
		cpuSeconds: slot => {
			let pid = children.get(slot)?.child.pid;
			if (pid === undefined) return undefined;
			try {
				// Fields 14 and 15 of /proc/<pid>/stat, in ticks of 1/100 s, counted after the command's name.
				let fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1)!.trim().split(" ");
				return (Number(fields[11]) + Number(fields[12])) / 100;
			} catch {
				return undefined;
			}
		},
		log: async slot => {
			let held = children.get(slot)?.log;
			return held ? `${held.lines.join("\n")}\n${held.text}` : "";
		},
		close: async () => {
			for (let slot of ["a", "b"] as const) await slots.stop(slot).catch(() => {});
			await proxy.stop().catch(() => {});
			if (!options.keepDatabase) {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
			}
			await admin.close();
		},
	};
}

async function composeEnvironment(options: EnvironmentOptions): Promise<Environment> {
	if (!options.image) throw new Error("--image names the image to deploy");
	let origin = `http://${HOST}:${options.port}`;
	// The override file takes what the slots are told from the compose command's own environment.
	let told = serverEnvironment(options, origin);
	for (let [key, value] of Object.entries(told)) process.env[`LOAD_${key}`] = value;
	let overlap: Options = {
		mode: "compose",
		command: "up",
		image: options.image,
		port: options.port,
		clients: 0,
		intervalMs: 0,
		warmMs: 0,
		settleMs: 0,
		handOvers: 0,
		maxGapMs: 0,
	};
	let { slots, database, command } = composeSlots(overlap, [LOAD_COMPOSE]);
	let ports = slotPorts(options.port);
	let started = await command("up", "--detach", "--wait", "db", "chopin-a", "caddy");
	if (started.code !== 0) throw new Error(`could not start the project:\n${started.out}`);
	return {
		origin,
		port: options.port,
		database,
		mode: "compose",
		proxy: "the reference Caddy of the compose project (deploy/overlap/Caddyfile)",
		slotUrl: (slot, path) => `http://${HOST}:${ports[slot]}${path}`,
		serving: slots.serving,
		state: slots.state,
		start: slots.start,
		stop: slots.stop,
		log: slots.log,
		close: async () => {
			await command("down", "--volumes").catch(() => {});
		},
	};
}
