import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Output } from "./output";
import {
	agentFolder,
	plannerDisk,
	plannerDisks,
	plannerReset,
	plannerServer,
	readPlannerReset,
	tokenFolder,
} from "./workspace";

/** How long a Planner's disk is kept after its Planner last ran, when Chopin says nothing of it. */
export const PLANNER_DISK_DAYS = 30;

/** How often a connector looks for Planner disks to remove. */
export const PLANNER_DISK_SWEEP_MS = 60 * 60_000;

/**
 * Asks Chopin which of the documents this machine keeps Planner disks for, each with the reset its
 * disk was made after, it may forget: `forget`, each archived or gone, and `reset`, each whose
 * Planner a writer reset since. A document it can't say for is kept.
 */
export type ForgetAsk = (
	disks: Array<{ id: string; reset?: number }>,
) => Promise<{ forget: string[]; reset: string[] }>;

/** Why a disk Chopin said its document's Planner was reset since goes. */
const RESET = "its Planner was reset in Chopin";

/** The holds this process has on disks, by lock file, each counted once per holder. */
const held = new Map<string, number>();
/** The lock files this process's sweeps hold while they look at a disk and remove it. */
const sweeping = new Set<string>();

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Takes `<disk>.held`, a file naming this process, unless a live process other than this one holds
 * it; one whose process is gone is taken over. True once it is this process's.
 */
async function lock(path: string): Promise<boolean> {
	for (;;) {
		// Made whole beside it, then linked into place, which fails where it is there: no other
		// process ever reads a lock half written.
		let temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(temporary, String(process.pid), { mode: 0o600 });
		try {
			await link(temporary, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			await rm(temporary, { force: true });
		}
		let owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
		if (owner > 0 && owner !== process.pid && alive(owner)) return false;
		// This process's own: a sweep of it, or a launch, has it.
		if (owner === process.pid && (sweeping.has(path) || held.has(path))) return false;
		// Left by a process that is gone, or one this process no longer holds: taken over.
		await rm(path, { force: true });
	}
}

/**
 * Holds a Planner's disk for one launch, so no sweep removes it while its microVM may use it: from
 * before the disk is made or touched until the backend exits. Holds of one process count, so a
 * spare's slot handed to a document stays held until both let go. Throws, naming the holder, when
 * another process still holds it after `waitMs` (a sweep finishing, say).
 */
export async function holdDisk(disk: string, waitMs = 10_000): Promise<() => Promise<void>> {
	let path = `${disk}.held`;
	let count = held.get(path) ?? 0;
	if (!count) {
		let until = Date.now() + waitMs;
		while (!await lock(path)) {
			if (Date.now() >= until) {
				let owner = (await readFile(path, "utf8").catch(() => "")).trim();
				throw new Error(`Its disk is in use by another chopin (process ${owner}).`);
			}
			await Bun.sleep(200);
		}
	}
	held.set(path, count + 1);
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		let left = (held.get(path) ?? 1) - 1;
		if (left > 0) {
			held.set(path, left);
			return;
		}
		held.delete(path);
		await rm(path, { force: true });
	};
}

/** Removes a Planner's slot: its disk, its token folder and its agents' state. */
export async function removePlannerSlot(slot: string) {
	await rm(`${slot}.disk`, { force: true });
	await rm(plannerServer(slot), { force: true });
	await rm(plannerReset(slot), { force: true });
	await rm(tokenFolder(slot), { recursive: true, force: true });
	await rm(agentFolder(slot), { recursive: true, force: true });
}

/**
 * Removes the Planner disks this machine no longer needs, never one a launch holds (see
 * `holdDisk`): each of a document Chopin says is archived or gone, and each no Planner has run on
 * for `days`. Each is taken as a launch takes it before it is looked at, so no launch can start on
 * it while it goes. A disk holds the Planner's own clone, so commits on it that were never pushed go
 * with it; the words say so. With `everything`, why the machine is unpaired or revoked, every disk of
 * that server's not held goes, a spare's that never got a document too.
 */
export async function sweepPlannerDisks(options: {
	directory: string;
	/** The Chopin server asked, or unpaired from: only its documents' disks go but by age. */
	server: string;
	output?: Output;
	ask?: ForgetAsk;
	/**
	 * Runs once before removing the slot of a document Chopin says is archived or gone (`forget`,
	 * never `reset`, age or `everything`), while the sweep holds its disk lock and its agent folder
	 * still exists. Errors never stop the disk's removal.
	 */
	beforeForget?: (item: { document: string; repository: string; slot: string }) => Promise<void>;
	now?: number;
	days?: number;
	everything?: string;
}): Promise<string[]> {
	let busy = (path: string) => (held.get(`${path}.held`) ?? 0) > 0;
	let disks = (await plannerDisks(options.directory, { spares: !!options.everything })).filter(
		item => !item.earlier && !busy(item.path),
	);
	if (!disks.length) return [];
	// Another server's documents are never this one's to forget.
	let ours = disks.filter(item => item.server === options.server);
	let forget = options.everything ? new Set(ours.map(item => item.document)) : new Set<string>();
	let reset = new Set<string>();
	if (!options.everything && options.ask && ours.length) {
		let named = new Map(ours.map(item => [item.document, item.reset]));
		let asked = await options.ask(
			[...named].map(([id, at]) => at === undefined ? { id } : { id, reset: at }),
		).catch(() => ({ forget: [], reset: [] }));
		for (let document of asked.forget) forget.add(document);
		for (let document of asked.reset) reset.add(document);
	}
	let forgotten = (item: (typeof disks)[number]) =>
		item.server === options.server && (forget.has(item.document) || reset.has(item.document));
	let now = options.now ?? Date.now();
	let oldest = now - (options.days ?? PLANNER_DISK_DAYS) * 24 * 60 * 60_000;
	let removed: string[] = [];
	for (let item of disks) {
		let why = forgotten(item)
			? options.everything
				?? (forget.has(item.document) ? "Chopin no longer has its document" : RESET)
			: ((await stat(item.path).catch(() => undefined))?.mtimeMs ?? now) < oldest
			? `no Planner ran on it for ${options.days ?? PLANNER_DISK_DAYS} days`
			: undefined;
		if (!why) continue;
		// Taken first, as a launch would take it, so none starts on it while it goes; one a launch
		// holds is left.
		let path = `${item.path}.held`;
		if (busy(item.path) || !await lock(path)) continue;
		sweeping.add(path);
		try {
			// Its age read again, now that no launch can touch it.
			if (!forgotten(item)) {
				let used = (await stat(item.path).catch(() => undefined))?.mtimeMs ?? now;
				if (used >= oldest) continue;
			}
			let slot = item.path.slice(0, -".disk".length);
			if (
				!options.everything && item.server === options.server && forget.has(item.document)
				&& options.beforeForget
			) {
				await options.beforeForget({
					document: item.document,
					repository: item.repository,
					slot,
				}).catch(() => {});
			}
			await removePlannerSlot(slot);
		} finally {
			sweeping.delete(path);
			await rm(path, { force: true });
		}
		removed.push(item.document);
		sayRemoved(options.output, item, why);
	}
	return removed;
}

function sayRemoved(
	output: Output | undefined,
	item: { document: string; repository: string },
	why: string,
) {
	output?.say(
		output.style.dim(
			`… Removed the disk of ${item.document}'s Planner (${item.repository}): ${why}. `
				+ "Any commits on it that were never pushed went with it.",
		),
	);
}

/**
 * Before a launch of a document's Planner in `slot`: removes its disk where it was made before the
 * reset Chopin names with the Planner's credential (`reset`, or none), so the Planner starts afresh
 * as Chopin's did. Taken as a launch takes it, so no other launch or sweep has it meanwhile. True
 * once it went.
 */
export async function forgetResetDisk(
	slot: string,
	reset: number | undefined,
	item: { document: string; repository: string; output?: Output },
): Promise<boolean> {
	let disk = plannerDisk(slot);
	if (!existsSync(disk) || await readPlannerReset(slot) === reset) return false;
	// One this process's launch still has is left for it.
	if ((held.get(`${disk}.held`) ?? 0) > 0) return false;
	let release = await holdDisk(disk);
	try {
		await removePlannerSlot(slot);
	} finally {
		await release();
	}
	sayRemoved(item.output, item, RESET);
	return true;
}

/** Records that the disk in `slot` was made after the reset Chopin named, or none. */
export async function stampPlannerReset(slot: string, reset: number | undefined) {
	if (reset === undefined) await rm(plannerReset(slot), { force: true });
	else await writeFile(plannerReset(slot), `${reset}\n`, { mode: 0o600 });
}
