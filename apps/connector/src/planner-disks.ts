import { readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Output } from "./output";
import { agentFolder, plannerDisks, tokenFolder } from "./workspace";

/** How long a Planner's disk is kept after its Planner last ran, when Chopin says nothing of it. */
export const PLANNER_DISK_DAYS = 30;

/** How often a connector looks for Planner disks to remove. */
export const PLANNER_DISK_SWEEP_MS = 60 * 60_000;

/**
 * Asks Chopin which of `documents` this machine may forget the Planners of: a document archived or
 * gone. A document it can't say for is kept.
 */
export type ForgetAsk = (documents: string[]) => Promise<string[]>;

/** The holds this process has on disks, by lock file, each counted once per holder. */
const held = new Map<string, number>();

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
		try {
			await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
		if (owner > 0 && owner !== process.pid && alive(owner)) return false;
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
	await rm(tokenFolder(slot), { recursive: true, force: true });
	await rm(agentFolder(slot), { recursive: true, force: true });
}

/**
 * Removes the Planner disks this machine no longer needs, never one a launch holds (see
 * `holdDisk`): each of a document Chopin says is archived or gone, and each no Planner has run on
 * for `days`. Each is taken as a launch takes it before it is looked at, so no launch can start on
 * it while it goes. A disk holds the Planner's own clone, so commits on it that were never pushed go
 * with it; the words say so. With `everything`, as when the machine is unpaired or revoked, every
 * disk not held goes.
 */
export async function sweepPlannerDisks(options: {
	directory: string;
	output?: Output;
	ask?: ForgetAsk;
	now?: number;
	days?: number;
	everything?: boolean;
}): Promise<string[]> {
	let busy = (path: string) => (held.get(`${path}.held`) ?? 0) > 0;
	let disks = (await plannerDisks(options.directory)).filter(item =>
		!item.earlier && !busy(item.path)
	);
	if (!disks.length) return [];
	let forget = options.everything ? new Set(disks.map(item => item.document)) : new Set<string>();
	if (!options.everything && options.ask) {
		let asked = await options.ask([...new Set(disks.map(item => item.document))]).catch(() => []);
		for (let document of asked) forget.add(document);
	}
	let now = options.now ?? Date.now();
	let oldest = now - (options.days ?? PLANNER_DISK_DAYS) * 24 * 60 * 60_000;
	let removed: string[] = [];
	for (let item of disks) {
		let why = forget.has(item.document)
			? options.everything
				? "this machine was unpaired from Chopin"
				: "Chopin no longer has its document"
			: ((await stat(item.path).catch(() => undefined))?.mtimeMs ?? now) < oldest
			? `no Planner ran on it for ${options.days ?? PLANNER_DISK_DAYS} days`
			: undefined;
		if (!why) continue;
		// Taken first, as a launch would take it, so none starts on it while it goes; one a launch
		// holds is left.
		let path = `${item.path}.held`;
		if (busy(item.path) || !await lock(path)) continue;
		try {
			// Its age read again, now that no launch can touch it.
			if (!forget.has(item.document)) {
				let used = (await stat(item.path).catch(() => undefined))?.mtimeMs ?? now;
				if (used >= oldest) continue;
			}
			await removePlannerSlot(item.path.slice(0, -".disk".length));
		} finally {
			await rm(path, { force: true });
		}
		removed.push(item.document);
		options.output?.say(
			options.output.style.dim(
				`… Removed the disk of ${item.document}'s Planner (${item.repository}): ${why}. `
					+ "Commits on it that were never pushed went with it.",
			),
		);
	}
	return removed;
}
