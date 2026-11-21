import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetResetDisk, holdDisk, stampPlannerReset, sweepPlannerDisks } from "./planner-disks";

let scratch = await mkdtemp(join(tmpdir(), "chopin-planner-disks-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const DAY = 24 * 60 * 60_000;

/** The Chopin server the disks are for, and another the same state directory is paired with. */
const A = "https://a.example";
const B = "https://b.example";

/**
 * A state directory with a Planner slot for each of `documents`: its disk, tokens and agent state,
 * on server A unless `servers` names another.
 */
async function machine(documents: string[], servers: Record<string, string> = {}) {
	let directory = await mkdtemp(join(scratch, "state-"));
	let folder = join(directory, "planners", "octo-org", "score");
	await mkdir(folder, { recursive: true });
	for (let document of documents) {
		await writeFile(join(folder, `${document}.disk`), "");
		await writeFile(join(folder, `${document}.server`), `${servers[document] ?? A}\n`);
		await mkdir(join(folder, `${document}.tokens`));
		await mkdir(join(folder, `${document}.agent`));
	}
	let slot = (document: string) => join(folder, document);
	return {
		directory,
		slot,
		kept: (document: string) =>
			[".disk", ".tokens", ".agent"].map(end => existsSync(`${slot(document)}${end}`)),
		/** Holds `document`'s disk, as a launch running on it does. */
		running: (document: string) => holdDisk(`${slot(document)}.disk`),
	};
}

const D = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

test("a Planner's disk goes once Chopin no longer has its document, its tokens and agents' state with it, never while a launch holds it", async () => {
	let it = await machine([D(1), D(2), D(3)]);
	let release = await it.running(D(3));
	let asked: string[][] = [];
	let said = "";
	let output = {
		say: (...lines: string[]) => void (said += lines.join("\n")),
		style: { dim: (text: string) => text },
	} as unknown as Parameters<typeof sweepPlannerDisks>[0]["output"];
	let removed = await sweepPlannerDisks({
		directory: it.directory,
		server: A,
		output,
		ask: async documents => {
			asked.push(documents.map(item => item.id).sort());
			return { forget: [D(1), D(3)], reset: [] };
		},
	});
	// The disk a microVM runs on is never asked about, nor removed.
	expect(asked).toEqual([[D(1), D(2)]]);
	expect(removed).toEqual([D(1)]);
	expect(it.kept(D(1))).toEqual([false, false, false]);
	expect(it.kept(D(2))).toEqual([true, true, true]);
	expect(it.kept(D(3))).toEqual([true, true, true]);
	expect(said).toContain("Chopin no longer has its document");
	expect(said).toContain("Any commits on it that were never pushed went with it.");
	// Let go, it goes at the next sweep.
	await release();
	let gone = async () => ({ forget: [D(3)], reset: [] });
	expect(await sweepPlannerDisks({ directory: it.directory, server: A, ask: gone })).toEqual([
		D(3),
	]);
});

test("a disk another chopin holds is left, one a chopin that is gone held is taken over, and no launch starts on one another holds", async () => {
	let it = await machine([D(1), D(2)]);
	// Another process, alive, holds D(1); one that is gone held D(2).
	let other = Bun.spawn(["sleep", "30"]);
	try {
		await writeFile(`${it.slot(D(1))}.disk.held`, String(other.pid));
		await writeFile(`${it.slot(D(2))}.disk.held`, "999999999");
		let removed = await sweepPlannerDisks({
			directory: it.directory,
			server: A,
			ask: async () => ({ forget: [D(1), D(2)], reset: [] }),
		});
		expect(removed).toEqual([D(2)]);
		expect(it.kept(D(1))).toEqual([true, true, true]);
		await expect(holdDisk(`${it.slot(D(1))}.disk`, 300)).rejects.toThrow(
			`Its disk is in use by another chopin (process ${other.pid}).`,
		);
	} finally {
		other.kill();
	}
});

test("a launch that asks for a disk while this process's sweep has it waits, then makes its own, which the sweep leaves", async () => {
	let it = await machine([D(1)]);
	let disk = `${it.slot(D(1))}.disk`;
	let old = new Date(Date.now() - 40 * DAY);
	await utimes(disk, old, old);
	let sweep = sweepPlannerDisks({ directory: it.directory, server: A });
	for (let wait = 0; wait < 200 && !existsSync(`${disk}.held`); wait++) await Bun.sleep(1);
	let release = await holdDisk(disk, 5_000);
	// The sweep took it before the launch could; the launch makes a new one, which stays its own.
	expect(existsSync(disk)).toBe(false);
	await writeFile(disk, "");
	expect(await sweep).toEqual([D(1)]);
	expect(existsSync(disk)).toBe(true);
	expect(existsSync(`${disk}.held`)).toBe(true);
	await release();
	expect(existsSync(`${disk}.held`)).toBe(false);
});

test("a disk no Planner ran on for 30 days goes, a newer one stays, and Chopin out of reach keeps the rest", async () => {
	let it = await machine([D(1), D(2)]);
	let now = Date.now();
	await utimes(`${it.slot(D(1))}.disk`, new Date(now - 31 * DAY), new Date(now - 31 * DAY));
	await utimes(`${it.slot(D(2))}.disk`, new Date(now - 29 * DAY), new Date(now - 29 * DAY));
	let removed = await sweepPlannerDisks({
		directory: it.directory,
		server: A,
		now,
		ask: () => Promise.reject(new Error("Chopin is out of reach")),
	});
	expect(removed).toEqual([D(1)]);
	expect(it.kept(D(2))).toEqual([true, true, true]);
});

test("an unpaired or revoked machine's disks all go, a spare's too, but one a launch still holds", async () => {
	let it = await machine([D(1), D(2), "spare-0123456789ab"]);
	await it.running(D(2));
	let asked = false;
	let removed = await sweepPlannerDisks({
		directory: it.directory,
		server: A,
		everything: "unpaired",
		ask: async () => {
			asked = true;
			return { forget: [], reset: [] };
		},
	});
	expect(asked).toBe(false);
	expect(removed.sort()).toEqual([D(1), "spare-0123456789ab"]);
	expect(it.kept(D(2))).toEqual([true, true, true]);
	expect(it.kept("spare-0123456789ab")).toEqual([false, false, false]);
});

test("only the server a disk's document is on may say it is gone, or unpair it away; age goes for any", async () => {
	let it = await machine([D(1), D(2)], { [D(2)]: B });
	// B answers that it has neither, as it has never had A's document.
	let neither = async (ids: Array<{ id: string }>) => ({
		forget: ids.map(item => item.id),
		reset: [],
	});
	expect(await sweepPlannerDisks({ directory: it.directory, server: B, ask: neither }))
		.toEqual([D(2)]);
	expect(it.kept(D(1))).toEqual([true, true, true]);
	let more = await machine([D(1), D(2)], { [D(2)]: B });
	expect(await sweepPlannerDisks({ directory: more.directory, server: B, everything: "unpaired" }))
		.toEqual([D(2)]);
	expect(more.kept(D(1))).toEqual([true, true, true]);
	let now = Date.now();
	await utimes(`${more.slot(D(1))}.disk`, new Date(now - 31 * DAY), new Date(now - 31 * DAY));
	expect(await sweepPlannerDisks({ directory: more.directory, server: B, now })).toEqual([D(1)]);
});

test("a disk made before a writer last reset its Planner goes, at a sweep or before its next launch, and one made after stays", async () => {
	let it = await machine([D(1), D(2), D(3)]);
	await stampPlannerReset(it.slot(D(2)), 1_000);
	await stampPlannerReset(it.slot(D(3)), 2_000);
	let asked: Array<{ id: string; reset?: number }> = [];
	let said = "";
	let output = {
		say: (...lines: string[]) => void (said += lines.join("\n")),
		style: { dim: (text: string) => text },
	} as unknown as Parameters<typeof sweepPlannerDisks>[0]["output"];
	// Chopin says D(1), made after no reset, and D(2), made after one before its last, were reset.
	let removed = await sweepPlannerDisks({
		directory: it.directory,
		server: A,
		output,
		ask: async documents => {
			asked.push(...documents);
			return { forget: [], reset: [D(1), D(2)] };
		},
	});
	expect(asked.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
		{ id: D(1) },
		{ id: D(2), reset: 1_000 },
		{ id: D(3), reset: 2_000 },
	]);
	expect(removed.sort()).toEqual([D(1), D(2)]);
	expect(it.kept(D(3))).toEqual([true, true, true]);
	expect(said).toContain("its Planner was reset in Chopin");
	expect(said).toContain("Any commits on it that were never pushed went with it.");

	// Its next launch: the credential names the reset Chopin has. Equal keeps it; later removes it.
	let item = { document: D(3), repository: "octo-org/score" };
	expect(await forgetResetDisk(it.slot(D(3)), 2_000, item)).toBe(false);
	expect(it.kept(D(3))).toEqual([true, true, true]);
	// One a launch of this process still holds is left for it.
	let release = await it.running(D(3));
	expect(await forgetResetDisk(it.slot(D(3)), 3_000, item)).toBe(false);
	await release();
	expect(await forgetResetDisk(it.slot(D(3)), 3_000, item)).toBe(true);
	expect(it.kept(D(3))).toEqual([false, false, false]);
	expect(existsSync(`${it.slot(D(3))}.reset`)).toBe(false);
	expect(existsSync(`${it.slot(D(3))}.disk.held`)).toBe(false);
	// A disk from before any reset, with none Chopin names, stays.
	let fresh = await machine([D(4)]);
	expect(await forgetResetDisk(fresh.slot(D(4)), undefined, item)).toBe(false);
	expect(fresh.kept(D(4))).toEqual([true, true, true]);
});
