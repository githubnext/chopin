/**
 * Runs a deploy that overlaps two Chopin processes behind the reference proxy
 * (`deploy/overlap/Caddyfile`), and reports what the overlap cost a client: how many requests
 * failed and how long it was from the old process releasing the writer lease until a request was
 * answered again. See docs/zero-downtime-deploys.md.
 *
 *   bun scripts/overlap.ts compose up|deploy|down --image <image>
 *   bun scripts/overlap.ts processes --database <url> [--hand-overs <n>]
 *
 * `compose` drives the project in `deploy/overlap/compose.yaml`, the way a deploy script
 * does: the idle slot is started beside the serving one, and the serving one is stopped only once
 * the idle one is waiting in standby. `processes` runs two `apps/server/src/main.ts` processes on
 * the host behind the same proxy in a container on the host's network (Linux), which is how the
 * browser restart test overlaps them. It needs the built client (`bun run build`).
 */
import { SQL } from "bun";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { ChildProcess } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CADDYFILE = fileURLToPath(new URL("../deploy/overlap/Caddyfile", import.meta.url));
const COMPOSE_FILE = fileURLToPath(new URL("../deploy/overlap/compose.yaml", import.meta.url));

export const CADDY_IMAGE = "caddy:2.11-alpine";
/** The design's budget for the proxy to serve again, from the release, and the browser's grace. */
export const BUDGET_MS = 750;
export const GRACE_MS = 1_500;

export type Slot = "a" | "b";
const other = (slot: Slot): Slot => slot === "a" ? "b" : "a";

export type Sample = {
	method: string;
	path: string;
	/** `performance.now()` when the request was sent and when its answer (or failure) arrived. */
	startedAt: number;
	endedAt: number;
	/** Undefined when the request got no answer at all. */
	status?: number;
};

const answered = (sample: Sample) =>
	sample.status !== undefined && sample.status >= 200 && sample.status < 300;

export type HandOverReport = {
	requests: number;
	/** Every request that was not answered 2xx. */
	failures: Sample[];
	/** Milliseconds from the release until the first request answered after it, if any was. */
	gapMs?: number;
	/** The longest any request waited for its answer. */
	longestMs: number;
	/** Requests sent before the release and answered after it: the ones the proxy held. */
	heldAcrossRelease: number;
};

/**
 * What the samples say about a hand-over whose release was seen at `releasedAt`. The old process
 * answers nothing once it has released the lease, so the first answer after it is the new
 * process's, and the time to it is the gap a client lives through.
 */
export function measureHandover(samples: Sample[], releasedAt: number): HandOverReport {
	let after = samples.filter(sample => answered(sample) && sample.endedAt > releasedAt);
	let first = after.reduce<number | undefined>(
		(least, sample) => least === undefined || sample.endedAt < least ? sample.endedAt : least,
		undefined,
	);
	return {
		requests: samples.length,
		failures: samples.filter(sample => !answered(sample)),
		gapMs: first === undefined ? undefined : Math.round(first - releasedAt),
		longestMs: Math.round(Math.max(0, ...samples.map(sample => sample.endedAt - sample.startedAt))),
		heldAcrossRelease:
			samples.filter(sample => sample.startedAt < releasedAt && sample.endedAt > releasedAt).length,
	};
}

/** Clients that go on asking, as tabs and connectors do: reads, a page, and an idempotent POST. */
export class Probe {
	#samples: Sample[] = [];
	private running = false;
	#loops: Promise<void>[] = [];

	constructor(
		private readonly origin: string,
		private readonly options: { clients: number; intervalMs: number },
	) {}

	start(): void {
		this.running = true;
		let requests: [string, string][] = [
			["GET", "/api/health/live"],
			["GET", "/api/session"],
			["GET", "/"],
			["POST", "/auth/logout"],
		];
		for (let client = 0; client < this.options.clients; client++) {
			this.#loops.push((async () => {
				for (let count = client; this.running; count += this.options.clients) {
					let [method, path] = requests[count % requests.length]!;
					let startedAt = performance.now();
					let sample: Sample = { method, path, startedAt, endedAt: startedAt };
					try {
						let response = await fetch(`${this.origin}${path}`, {
							method,
							headers: method === "POST" ? { origin: this.origin } : {},
							redirect: "manual",
							signal: AbortSignal.timeout(10_000),
						});
						await response.arrayBuffer();
						sample.status = response.status;
					} catch { /* No answer. */ }
					sample.endedAt = performance.now();
					this.#samples.push(sample);
					await Bun.sleep(this.options.intervalMs);
				}
			})());
		}
	}

	async stop(): Promise<Sample[]> {
		this.running = false;
		await Promise.all(this.#loops);
		return this.#samples;
	}
}

/** Watches the writer lease row with plain reads, as the waiting process does. */
export function watchLease(url: string): { released: Promise<number>; close(): Promise<void> } {
	let sql = new SQL(url);
	let watching = { open: true };
	let released = (async () => {
		let owner: string | undefined;
		while (watching.open) {
			let [row] = await sql<{ owner: string; free: boolean }[]>`
				SELECT owner, expires_at <= clock_timestamp() AS free
				FROM storage_leases WHERE name = 'chopin:writer'
			`;
			let at = performance.now();
			owner ??= row?.owner;
			if (row && (row.free || row.owner !== owner)) return at;
			await Bun.sleep(2);
		}
		throw new Error("the lease was not released");
	})();
	return {
		released,
		close: async () => {
			watching.open = false;
			await released.catch(() => {});
			await sql.close();
		},
	};
}

/** The two slots a deploy alternates between, however they are run. */
export type Slots = {
	/** The slot that answers ready, if one does. */
	serving(): Promise<Slot | undefined>;
	/** The status word of the slot's `live` check, if it answers. */
	state(slot: Slot): Promise<string | undefined>;
	/** Starts the slot beside the other. */
	start(slot: Slot): Promise<void>;
	/** Sends the slot SIGTERM and returns when it has stopped, with how it exited. */
	stop(slot: Slot): Promise<number | null>;
	/** What the slot logged, for the cut's own report. */
	log(slot: Slot): Promise<string>;
};

export async function until<T>(
	what: string,
	read: () => Promise<T | undefined | false>,
	ms = 60_000,
): Promise<T> {
	let deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		let value = await read();
		if (value) return value;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

export type HandOver = {
	from: Slot;
	to: Slot;
	exit: number | null;
	report: HandOverReport;
	/** Lines of the old slot's log about its cut. */
	cut: string[];
};

/**
 * One deploy: the idle slot starts beside the serving one and the serving one is stopped only
 * once the idle one waits in standby, with `probe` asking the proxy throughout.
 */
export async function handOver(
	slots: Slots,
	lease: () => { released: Promise<number>; close(): Promise<void> },
	probe: Pick<Probe, "start" | "stop">,
	timing: { warmMs: number; settleMs: number },
): Promise<HandOver> {
	let from = await slots.serving();
	if (!from) throw new Error("no slot is serving; bring one up first");
	let to = other(from);
	let watching = lease();
	try {
		probe.start();
		await slots.start(to);
		await until(`slot ${to} to wait in standby`, async () => {
			let state = await slots.state(to);
			return state === "standby" || state === "ready";
		});
		// The proxy must have found the new slot and checked it before the old one lets go: a
		// stopped slot's name does not resolve, and a check hung on it can take the health timeout
		// and the interval to notice that the name does.
		await Bun.sleep(timing.warmMs);
		let exit = await slots.stop(from);
		let releasedAt = await watching.released;
		await until(`slot ${to} to be ready`, async () => (await slots.serving()) === to);
		await Bun.sleep(timing.settleMs);
		let samples = await probe.stop();
		let cut = (await slots.log(from)).split("\n").filter(line =>
			/readiness check|cut finished|closing .* without an answer/.test(line)
		);
		return { from, to, exit, report: measureHandover(samples, releasedAt), cut };
	} finally {
		await probe.stop();
		await watching.close();
	}
}

export async function text(url: string): Promise<[number, string] | undefined> {
	try {
		let response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
		return [response.status, (await response.text()).trim()];
	} catch {
		return undefined;
	}
}

/** Whether something accepts connections on the port; unlike a request, it does not wait on an upstream. */
function accepts(port: number): Promise<boolean> {
	return new Promise(resolve => {
		let socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

export type Run = { code: number | null; out: string };

export function run(
	command: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Run> {
	return new Promise(resolve => {
		let child = spawn(command, args, {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", chunk => out += chunk);
		child.stderr.on("data", chunk => out += chunk);
		child.on("close", code => resolve({ code, out }));
	});
}

export type Options = {
	mode: "compose" | "processes";
	command: "up" | "deploy" | "down";
	image?: string;
	database?: string;
	port: number;
	clients: number;
	intervalMs: number;
	warmMs: number;
	settleMs: number;
	handOvers: number;
	maxGapMs: number;
};

const USAGE = `usage:
  bun scripts/overlap.ts compose up|deploy|down --image <image> [options]
  bun scripts/overlap.ts processes --database <url> [options]
options: --port <proxy port, 8080> --clients <4> --interval-ms <15> --warm-ms <1500>
         --settle-ms <2000> --hand-overs <1, processes only> --max-gap-ms <${GRACE_MS}>`;

export function parseArguments(argv: string[], env: Record<string, string | undefined>): Options {
	let { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			image: { type: "string" },
			database: { type: "string" },
			port: { type: "string", default: "8080" },
			clients: { type: "string", default: "4" },
			"interval-ms": { type: "string", default: "15" },
			"warm-ms": { type: "string", default: "1500" },
			"settle-ms": { type: "string", default: "2000" },
			"hand-overs": { type: "string", default: "1" },
			"max-gap-ms": { type: "string", default: String(GRACE_MS) },
		},
	});
	let number = (name: string, value: string | undefined, least: number): number => {
		let parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed < least) {
			throw new Error(`--${name} must be a whole number of at least ${least}\n${USAGE}`);
		}
		return parsed;
	};
	let [mode, command = "deploy"] = positionals;
	let shared = {
		port: number("port", values.port, 1),
		clients: number("clients", values.clients, 1),
		intervalMs: number("interval-ms", values["interval-ms"], 0),
		warmMs: number("warm-ms", values["warm-ms"], 0),
		settleMs: number("settle-ms", values["settle-ms"], 0),
		handOvers: number("hand-overs", values["hand-overs"], 1),
		maxGapMs: number("max-gap-ms", values["max-gap-ms"], 1),
	};
	if (mode === "compose") {
		if (command !== "up" && command !== "deploy" && command !== "down") {
			throw new Error(`unknown command ${command}\n${USAGE}`);
		}
		// Compose reads the image for every command, though taking the project down uses none.
		let image = values.image ?? env.CHOPIN_IMAGE ?? (command === "down" ? "none" : undefined);
		if (!image) throw new Error(`--image or CHOPIN_IMAGE names the image to run\n${USAGE}`);
		return { mode, command, image, ...shared };
	}
	if (mode === "processes") {
		let database = values.database ?? env.DATABASE_URL;
		if (!database) throw new Error(`--database names the disposable database\n${USAGE}`);
		return { mode, command: "deploy", database, ...shared };
	}
	throw new Error(USAGE);
}

/** The slots' host ports: the ones after the proxy's (the compose project's database takes the next). */
export const slotPorts = (port: number): Record<Slot, number> => ({ a: port + 1, b: port + 2 });

export function composeSlots(options: Options, extraFiles: string[] = []): {
	slots: Slots;
	database: string;
	command: (...args: string[]) => Promise<Run>;
} {
	let ports = slotPorts(options.port);
	let databasePort = options.port + 3;
	let env = {
		CHOPIN_IMAGE: options.image!,
		OVERLAP_PORT: String(options.port),
		OVERLAP_PORT_A: String(ports.a),
		OVERLAP_PORT_B: String(ports.b),
		OVERLAP_DB_PORT: String(databasePort),
		APP_ORIGIN: `http://127.0.0.1:${options.port}`,
	};
	let command = (...args: string[]) =>
		run("docker", [
			"compose",
			"-p",
			"chopin-overlap",
			"-f",
			COMPOSE_FILE,
			...extraFiles.flatMap(file => ["-f", file]),
			...args,
		], env);
	let ready = async (slot: Slot) =>
		(await text(`http://127.0.0.1:${ports[slot]}/api/health/ready`))?.[0] === 200;
	return {
		database: `postgresql://chopin:chopin@127.0.0.1:${databasePort}/chopin?sslmode=disable`,
		command,
		slots: {
			serving: async () => (await ready("a")) ? "a" : (await ready("b")) ? "b" : undefined,
			state: async slot => (await text(`http://127.0.0.1:${ports[slot]}/api/health/live`))?.[1],
			start: async slot => {
				let result = await command("up", "--detach", "--no-deps", `chopin-${slot}`);
				if (result.code !== 0) throw new Error(`could not start chopin-${slot}:\n${result.out}`);
			},
			stop: async slot => {
				// Uses the service's stop_grace_period, which the file sets to 30 s.
				let result = await command("stop", `chopin-${slot}`);
				if (result.code !== 0) throw new Error(`could not stop chopin-${slot}:\n${result.out}`);
				let inspected = await run("docker", [
					"inspect",
					"--format",
					"{{.State.ExitCode}}",
					`chopin-overlap-chopin-${slot}-1`,
				]);
				return Number(inspected.out.trim());
			},
			log: async slot =>
				(await command("logs", "--no-log-prefix", "--tail", "200", `chopin-${slot}`)).out,
		},
	};
}

/** The reference proxy in a container on the host's network, in front of two host ports. */
export async function startProxy(
	port: number,
	upstreams: Record<Slot, number>,
): Promise<{ stop(): Promise<void>; output(): string }> {
	let name = `chopin-overlap-proxy-${process.pid}`;
	let child = spawn("docker", [
		"run",
		"--rm",
		"--name",
		name,
		"--network",
		"host",
		"-e",
		`CHOPIN_SITE=:${port}`,
		"-e",
		`CHOPIN_SLOT_A=127.0.0.1:${upstreams.a}`,
		"-e",
		`CHOPIN_SLOT_B=127.0.0.1:${upstreams.b}`,
		"-v",
		`${CADDYFILE}:/etc/caddy/Caddyfile:ro`,
		CADDY_IMAGE,
	], { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", chunk => out += chunk);
	child.stderr.on("data", chunk => out += chunk);
	let stop = async () => {
		await run("docker", ["stop", "--time", "2", name]);
	};
	try {
		await until("the proxy to listen", async () => {
			if (child.exitCode !== null) throw new Error(`the proxy exited:\n${out.slice(-600)}`);
			return await accepts(port);
		}, 30_000);
	} catch (error) {
		await stop();
		throw error;
	}
	return { output: () => out, stop };
}

/** What a slot run on the host needs: the same placeholders the compose file sets. */
function serverEnvironment(options: Options, port: number): Record<string, string> {
	return {
		...process.env as Record<string, string>,
		AGENT: "off",
		BACKGROUND_JOBS: "off",
		HANDOVER: "wait",
		HANDOVER_UNREADY_MS: "300",
		JEV_API_KEY: "overlap-run-only",
		APP_ORIGIN: `http://127.0.0.1:${options.port}`,
		DATABASE_URL: options.database!,
		GITHUB_APP_SLUG: "chopin-overlap",
		GITHUB_APP_CLIENT_ID: "overlap",
		GITHUB_APP_CLIENT_SECRET: "overlap",
		GITHUB_ALLOWED_USERS: "",
		GITHUB_ALLOWED_ORGANIZATIONS: "",
		PORT: String(port),
		SERVER_HOST: "127.0.0.1",
		SESSION_ENCRYPTION_KEY: "22".repeat(32),
		STORAGE_DRIVER: "postgres",
	};
}

function processSlots(options: Options): Slots {
	let ports = slotPorts(options.port);
	let children = new Map<Slot, { child: ChildProcess; out: string }>();
	return {
		serving: async () => {
			for (let slot of ["a", "b"] as const) {
				if ((await text(`http://127.0.0.1:${ports[slot]}/api/health/ready`))?.[0] === 200) {
					return slot;
				}
			}
			return undefined;
		},
		state: async slot => (await text(`http://127.0.0.1:${ports[slot]}/api/health/live`))?.[1],
		start: async slot => {
			let child = spawn(process.execPath, ["apps/server/src/main.ts"], {
				cwd: ROOT,
				env: serverEnvironment(options, ports[slot]),
				stdio: ["ignore", "pipe", "pipe"],
			});
			let entry = { child, out: "" };
			child.stdout.on("data", chunk => entry.out += chunk);
			child.stderr.on("data", chunk => entry.out += chunk);
			children.set(slot, entry);
		},
		stop: async slot => {
			let child = children.get(slot)?.child;
			if (!child) return null;
			if (child.exitCode !== null) return child.exitCode;
			let exited = new Promise<number | null>(resolve => child.once("close", resolve));
			child.kill("SIGTERM");
			return exited;
		},
		log: async slot => children.get(slot)?.out ?? "",
	};
}

function print(done: HandOver, number?: number): void {
	let { report } = done;
	let title = `${number === undefined ? "" : `#${number} `}slot ${done.from} to slot ${done.to}`;
	console.log(
		`${title}: ${report.requests} requests, ${report.failures.length} not answered 2xx, `
			+ `${report.heldAcrossRelease} held across the release (longest wait ${report.longestMs} ms), `
			+ `first answer ${report.gapMs ?? "never"} ms after the release (budget ${BUDGET_MS} ms), `
			+ `old process exited ${done.exit}`,
	);
	for (let failure of report.failures.slice(0, 10)) {
		console.log(`  failed: ${failure.method} ${failure.path} -> ${failure.status ?? "no answer"}`);
	}
	for (let line of done.cut) console.log(`  ${line.trim()}`);
}

function failed(done: HandOver, options: Options): boolean {
	let { report } = done;
	return report.failures.length > 0 || report.gapMs === undefined || report.gapMs > options.maxGapMs
		|| done.exit !== 0;
}

async function main(): Promise<number> {
	let options = parseArguments(process.argv.slice(2), process.env);
	let probe = () =>
		new Probe(`http://127.0.0.1:${options.port}`, {
			clients: options.clients,
			intervalMs: options.intervalMs,
		});
	if (options.mode === "compose") {
		let { slots, database, command } = composeSlots(options);
		if (options.command === "up") {
			let result = await command(
				"up",
				"--detach",
				"--wait",
				"db",
				"chopin-a",
				"caddy",
			);
			console.log(result.out.trim());
			return result.code ?? 1;
		}
		if (options.command === "down") {
			return (await command("down", "--volumes")).code ?? 1;
		}
		let done = await handOver(slots, () => watchLease(database), probe(), {
			warmMs: options.warmMs,
			settleMs: options.settleMs,
		});
		print(done);
		return failed(done, options) ? 1 : 0;
	}
	if (!existsSync(`${ROOT}apps/web/dist/index.html`)) {
		throw new Error("the built client is missing; run `bun run build` first");
	}
	let ports = slotPorts(options.port);
	let migrated = await run(
		process.execPath,
		["apps/server/src/storage/migrate.ts"],
		serverEnvironment(options, ports.a),
	);
	if (migrated.code !== 0) throw new Error(`could not migrate the database:\n${migrated.out}`);
	let slots = processSlots(options);
	let proxy = await startProxy(options.port, ports);
	let status = 0;
	try {
		await slots.start("a");
		await until("slot a to be ready", async () => (await slots.serving()) === "a");
		for (let number = 1; number <= options.handOvers; number++) {
			let done = await handOver(
				slots,
				() => watchLease(options.database!),
				probe(),
				{ warmMs: options.warmMs, settleMs: options.settleMs },
			);
			print(done, number);
			if (failed(done, options)) status = 1;
		}
	} finally {
		for (let slot of ["a", "b"] as const) await slots.stop(slot).catch(() => {});
		await proxy.stop();
	}
	return status;
}

if (import.meta.main) {
	main().then(code => process.exit(code), error => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
