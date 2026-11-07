/**
 * One deploy of the run: the idle slot starts beside the serving one, the serving one is sent
 * SIGTERM once the idle one waits in standby, and every moment that matters is read off the two
 * slots and the lease row while it happens: when the old process heard the signal, turned
 * readiness off, stopped listening, released the lease; when the new one took it and answered
 * ready; and when the proxy first served a request again.
 */
import { SQL } from "bun";

import { measureHandover, Probe, until } from "../overlap";
import { parseCut, parseReady } from "./analysis";
import { other } from "./environment";

import type { HandOverReport } from "../overlap";
import type { CutLog } from "./analysis";
import type { Environment, Slot } from "./environment";

export type Moments = {
	/** All on the clock of `performance.now()`. */
	sigtermSentAt: number;
	/** The old process's first answer that carries `Connection: close`: it has heard the signal. */
	toldAt?: number;
	/** Its first answer to `ready` that is not 200. */
	unreadyAt?: number;
	/** Its first refused connection after that: the listener is stopped. */
	listenerStoppedAt?: number;
	releasedAt?: number;
	acquiredAt?: number;
	/** The new process's first `ready` 200. */
	readyAt?: number;
};

export type HandOverRecord = {
	index: number;
	from: Slot;
	to: Slot;
	exit: number | null;
	moments: Moments;
	/** Milliseconds from the old process hearing SIGTERM, for each moment that was seen. */
	sinceTold: Record<string, number>;
	cut: CutLog;
	ready?: { afterLeaseMs: number; phases: Record<string, number> };
	http: HandOverReport;
	/** `remote Planner miss` lines the new process logged. */
	plannerMissLines: number;
};

/** Watches both slots and the lease row until stopped; what it saw is `moments`. */
export function watch(env: Environment, from: Slot, to: Slot, sigtermSentAt: number) {
	let moments: Moments = { sigtermSentAt };
	let open = { on: true, closed: false };
	let sql = new SQL(env.database);
	let loops: Promise<void>[] = [];
	let health = async (slot: Slot, intervalMs: number) => {
		while (open.on) {
			let at = performance.now();
			try {
				let response = await fetch(env.slotUrl(slot, "/api/health/ready"), {
					signal: AbortSignal.timeout(500),
				});
				await response.arrayBuffer();
				at = performance.now();
				if (slot === from) {
					if (response.headers.get("connection") === "close") moments.toldAt ??= at;
					if (response.status !== 200) moments.unreadyAt ??= at;
				} else if (response.status === 200) moments.readyAt ??= at;
			} catch {
				if (slot === from && moments.unreadyAt !== undefined) {
					moments.listenerStoppedAt ??= performance.now();
				}
			}
			await Bun.sleep(intervalMs);
		}
	};
	loops.push(health(from, 4), health(to, 10));
	loops.push((async () => {
		let owner: string | undefined;
		while (open.on) {
			try {
				let [row] = await sql<{ owner: string; free: boolean }[]>`
					SELECT owner, expires_at <= clock_timestamp() AS free
					FROM storage_leases WHERE name = 'chopin:writer'
				`;
				let at = performance.now();
				owner ??= row?.owner;
				if (row && owner) {
					if ((row.free || row.owner !== owner) && moments.releasedAt === undefined) {
						moments.releasedAt = at;
					}
					if (row.owner !== owner && !row.free) moments.acquiredAt ??= at;
				}
			} catch { /* The next read tries again. */ }
			await Bun.sleep(2);
		}
	})());
	return {
		moments,
		released: until("the old process to release the lease", async () => moments.releasedAt, 60_000),
		async stop() {
			open.on = false;
			await Promise.all(loops);
			if (open.closed) return;
			open.closed = true;
			await sql.close();
		},
	};
}

export type Hooks = {
	/** Before the signal: arrange what the cut will find, such as turns that are running. */
	before?(): Promise<void>;
	/** After the old process says it is stopping and before it has finished: it is still serving. */
	during?(): Promise<void>;
};

/** One deploy. `probe` asks the proxy throughout. */
export async function handOver(
	env: Environment,
	index: number,
	probe: Probe,
	timing: { warmMs: number; settleMs: number },
	hooks: Hooks = {},
): Promise<HandOverRecord> {
	let from = await env.serving();
	if (!from) throw new Error("no slot is serving; bring one up first");
	let to = other(from);
	probe.start();
	let sigtermSentAt = 0;
	let watching: ReturnType<typeof watch> | undefined;
	try {
		await env.start(to);
		await until(`slot ${to} to wait in standby`, async () => {
			let state = await env.state(to);
			return state === "standby" || state === "ready";
		});
		// The proxy must have found the new slot and checked it before the old one lets go.
		await Bun.sleep(timing.warmMs);
		await hooks.before?.();
		sigtermSentAt = performance.now();
		watching = watch(env, from, to, sigtermSentAt);
		let exiting = env.stop(from);
		await until(
			"the old process to say it is stopping",
			async () => watching!.moments.toldAt,
			30_000,
		);
		await hooks.during?.();
		let exit = await exiting;
		let releasedAt = await watching.released;
		await until(`slot ${to} to be ready`, async () => (await env.serving()) === to, 60_000);
		await Bun.sleep(timing.settleMs);
		let samples = await probe.stop();
		await watching.stop();
		let moments = watching.moments;
		let told = moments.toldAt ?? sigtermSentAt;
		let sinceTold: Record<string, number> = {};
		for (let [name, at] of Object.entries(moments)) {
			if (name !== "sigtermSentAt" && at !== undefined) {
				sinceTold[name.replace(/At$/, "")] = Math.round(at - told);
			}
		}
		let oldLog = await env.log(from);
		let newLog = await env.log(to);
		return {
			index,
			from,
			to,
			exit,
			moments,
			sinceTold,
			cut: parseCut(oldLog),
			ready: parseReady(newLog),
			http: measureHandover(samples, releasedAt),
			plannerMissLines: (newLog.match(/remote Planner miss/g) ?? []).length,
		};
	} catch (error) {
		let logs = await Promise.all(
			[from, to].map(async slot => `--- slot ${slot}\n${(await env.log(slot)).slice(-2500)}`),
		);
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n${logs.join("\n")}`,
			{ cause: error },
		);
	} finally {
		await probe.stop();
		await watching?.stop();
	}
}
