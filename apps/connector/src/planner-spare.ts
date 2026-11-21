import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { basename, join } from "node:path";
import { clonePath } from "./checkouts";
import { redacted } from "./connection";
import { gitAsync } from "./git-host";
import { githubPaths } from "./github-token";
import type { Output } from "./output";
import { passMasked, plannerEnvironment, plannerGuest, stopBackend } from "./planner";
import { guestRepositoryPath } from "./nvx";
import { holdDisk } from "./planner-disks";
import { backoff } from "./reconnect";
import { type Sandbox, type Spawned, spawnIn } from "./sandbox";
import type { AgentStore } from "./machine-store";
import {
	agentFolder,
	assignedSlots,
	plannerDisk,
	plannerFolder,
	plannerServer,
	SPARE_SLOT,
	type SpareState,
	type SpareStates,
	tokenFolder,
} from "./workspace";

/**
 * Spare Planners: one Planner command per repository the machine recently ran a Planner in, its
 * clones included, and per registered checkout's repository, started ahead in its own microVM with
 * its code loaded, attached to nothing, so a new document's Planner only waits for its hand-over
 * and its attach instead of the microVM's boot and the command's whole start. The contract
 * between the connector and the command, spare protocol 1:
 *
 * - The connector offers spare mode by starting the command with `CHOPIN_PLANNER_SPARE=1` and no
 *   document or credential: only where its credentials will be, as files in its token folder.
 * - A command that takes it prints `chopin-planner-spare: ready {"protocol":1}` once it waits. One
 *   that never prints it within `readyMs`, or exits first, is recorded as not taking spare mode
 *   until the command's files change or a day passes, and new documents start cold, as before.
 * - The hand-over is JSON lines on its stdin: `assign` once, naming the document (its Planner
 *   credential and Chopin token files are written first), then `github` once the GitHub token file
 *   is there, with who commits; `stop` with a refusal. End of stdin means stop now, so no spare
 *   outlives its connector. No line ever holds a secret.
 *
 * A spare is bound to its repository from its start: its environment names the checkout
 * (`CHOPIN_CHECKOUT`) and its own repository (`CHOPIN_WORKTREE`), and its microVM's shares and the
 * clone on its disk are fixed when it boots. So there is no spare for a repository the machine has
 * not served yet, and that document starts cold.
 *
 * A spare is handed only a document with no Planner worktree on this machine yet; its slot becomes
 * that document's worktree for good (`assignSlot`), and it is never handed another. A replacement
 * starts `replaceMs` after a hand-over, so two never compete for the CPU while one attaches.
 */

/** The spare protocol this connector speaks. */
export const SPARE_PROTOCOL = 1;
/** The line a command prints on stdout once it waits in spare mode. */
export const READY_LINE = `chopin-planner-spare: ready ${
	JSON.stringify({ protocol: SPARE_PROTOCOL })
}`;
/** How long a spare has to print its ready line. */
export const READY_MS = 60_000;
/** A spare older than this is replaced, never handed a document. */
export const MAX_AGE_MS = 12 * 3_600_000;
/** How long after a hand-over the replacement spare starts. */
export const REPLACE_MS = 5_000;
/** How long a command found not to take spare mode isn't offered it again, unless it changes. */
export const UNSUPPORTED_MS = 24 * 3_600_000;
/** At most this many spares run on a machine. */
export const MAX_SPARES = 4;
/** A repository keeps its spare this long after a Planner last started in it. */
export const RECENT_MS = 7 * 24 * 3_600_000;
/** What one spare's microVM takes of the host's memory with its backend loaded: about 300 MB. */
export const SPARE_BYTES = 300 * 1024 * 1024;
/** Spares together take at most this share of the machine's memory. */
export const MEMORY_SHARE = 0.1;
/** A spare starts only while the machine would keep this much memory available beside it. */
export const RESERVE_BYTES = 1024 * 1024 * 1024;
/** How long Chopin's word that the machine can push to a repository holds, and how often it is asked again while its spare is kept. */
export const CHECK_MS = 10 * 60_000;
/** How long a spare held back for memory waits before it is tried again. */
const MEMORY_WAIT_MS = 60_000;
/** The longest line written to a spare's stdin. */
const LINE_BYTES = 65_536;
/** What a spare whose stdin ended has to exit by itself before its processes are stopped. */
const END_GRACE_MS = 1_000;

/** The variables a spare never inherits from the connector: they come with its hand-over. */
const HANDED = [
	"CHOPIN_DOCUMENT",
	"CHOPIN_PLANNER_TOKEN",
	"CHOPIN_GITHUB_TOKEN",
	"CHOPIN_GITHUB_TOKEN_EXPIRES_AT",
	"CHOPIN_STARTER_LOGIN",
	"CHOPIN_STARTER_NAME",
	"CHOPIN_STARTER_EMAIL",
	"CHOPIN_PLANNER_SPARE",
];

/** A started spare Planner, as a hand-over uses it. */
export type Spare = {
	repository: string;
	checkout: string;
	/** Its worktree, `spare-<id>` beside the documents', and the folder its credentials go in. */
	slot: string;
	tokens: string;
	child: Spawned;
	/** When it started (ms), and the identity of the command it runs. */
	started: number;
	identity: string;
	/**
	 * It started as a backend whose sessions run on people's AI accounts in Chopin, with nothing of
	 * the owner's agent setup (see `plannerEnvironment`): only such a document's Planner takes it.
	 */
	managed: boolean;
	/** How it ended: `exit 3`, `signal SIGTERM`, or why it couldn't start. */
	exited: Promise<string>;
	alive(): boolean;
	/**
	 * Its output from now on: masked with `secrets`, its stderr heard by `stderr`. Resolves once
	 * both streams closed.
	 */
	listen(hooks: { secrets: () => string[]; stderr?: (text: string) => void }): Promise<unknown>;
	/** Write one line to its stdin; false when it can't be written. */
	send(message: Record<string, unknown>): boolean;
	/** Throws when the checkout's HEAD moved since it started, so the document starts cold. */
	refresh(): Promise<void>;
	/** End its stdin and stop its processes; its slot stays. */
	stop(): Promise<void>;
	/** Stop it and remove its slot: a spare that never got a document. */
	discard(): Promise<void>;
};

export type PlannerSpares = {
	/**
	 * The repository's spare, ready and current and started as `managed` says, taken out of the pool
	 * for one document, for good; its replacement starts `replaceMs` later. Undefined when there is
	 * none to take: the document starts cold.
	 */
	take(repository: string, managed?: boolean): Promise<Spare | undefined>;
	/**
	 * A document's Planner started cold in `repository`, whose checkout (registered, or the
	 * machine's clone) is there: the repository is served, and keeps a spare from `replaceMs` on.
	 */
	served(repository: string): void;
	/**
	 * Chopin refused this machine a GitHub token for `repository`: its spare goes at once, and it
	 * gets none until Chopin says the machine can push there again.
	 */
	refused(repository: string): void;
	/**
	 * Chopin said whether its Planners' sessions run on people's AI accounts in Chopin: spares start
	 * so from now on, and one started otherwise is replaced.
	 */
	managed(value: boolean): void;
	/** Stop every spare that has no document and remove its slot. */
	stop(): Promise<void>;
};

/**
 * What identifies the command a spare runs: its program and the first file among its arguments
 * (a script), each by real path, size and modification time, so an upgrade in place is noticed.
 */
export async function commandIdentity(command: string[]): Promise<string> {
	let of = async (path: string) => {
		let real = await realpath(path);
		let info = await stat(real);
		return `${real}:${info.size}:${Math.floor(info.mtimeMs)}`;
	};
	let program = command[0] ?? "";
	let found = program.includes("/") || program.includes("\\") ? program : Bun.which(program);
	let parts = [await of(found ?? program).catch(() => program)];
	for (let word of command.slice(1)) {
		if (word.startsWith("-")) continue;
		if ((await stat(word).catch(() => undefined))?.isFile()) {
			parts.push(await of(word));
			break;
		}
	}
	return parts.join("|");
}

/**
 * `<base>/planner-spare.json`: commands found not to take spare mode, by command line, and when a
 * Planner last started in each repository (`served`), which the next connector keeps spares for.
 */
type SpareRecord = {
	unsupported?: Record<string, { identity: string; at: number }>;
	served?: Record<string, number>;
};

function recordFile(directory: string) {
	return join(directory, "planner-spare.json");
}

async function readRecord(directory: string): Promise<SpareRecord> {
	try {
		let value = JSON.parse(await readFile(recordFile(directory), "utf8")) as SpareRecord;
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

async function writeRecord(directory: string, value: SpareRecord) {
	let path = recordFile(directory);
	let temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, path);
}

/** Remove a slot that never got a document: its disk, its token folder and its agents' state. */
async function removeSlot(slot: string) {
	await rm(plannerDisk(slot), { force: true });
	await rm(plannerServer(slot), { force: true });
	await rm(slot, { recursive: true, force: true });
	await rm(tokenFolder(slot), { recursive: true, force: true });
	await rm(agentFolder(slot), { recursive: true, force: true });
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** The machine's memory in bytes: all of it, and what is available now. */
export type Memory = () => { total: number; available: number };

const MEMORY: Memory = () => ({ total: totalmem(), available: freemem() });

/**
 * How many spares a machine keeps: `cap`, and no more than take `MEMORY_SHARE` of its memory at
 * `SPARE_BYTES` each.
 */
export function spareBound(total: number, cap = MAX_SPARES) {
	return Math.max(0, Math.min(cap, Math.floor(total * MEMORY_SHARE / SPARE_BYTES)));
}

/**
 * The machine's spare Planners, while `signal` lasts: one for each of the repositories it most
 * recently ran a Planner in, within `RECENT_MS`, its clones included, and for its registered
 * checkouts' repositories, as many as `spareBound` allows. A spare starts only once `check` says
 * Chopin would give the machine a token to push to its repository, and while the machine has the
 * memory for it; one is let go as soon as Chopin refuses that. With `off`, none starts, and status
 * says so.
 */
export function plannerSpares(options: {
	url: string;
	command: string[];
	/** The registered checkouts, by repository. */
	registered: Record<string, string>;
	directory: string;
	output: Output;
	signal: AbortSignal;
	env?: Record<string, string>;
	sandbox: Sandbox;
	agentStore?: AgentStore;
	states?: SpareStates;
	off?: boolean;
	readyMs?: number;
	maxAgeMs?: number;
	replaceMs?: number;
	/**
	 * Whether spares start as backends whose sessions run on people's AI accounts in Chopin, until
	 * Chopin says otherwise (`managed`): not unless said.
	 */
	managed?: boolean;
	/**
	 * Whether Chopin would give this machine a token to push to `repository` (see
	 * `machineGitHubCheck`): `ok`, a refusal's code, or `unknown` when Chopin couldn't be asked.
	 * Asked before a spare starts, unless asked within `checkMs`, and every `checkMs` while one is
	 * kept. Without it, every repository may have one.
	 */
	check?: (repository: string) => Promise<string>;
	checkMs?: number;
	memory?: Memory;
	cap?: number;
	recentMs?: number;
}): PlannerSpares {
	let { output, directory, command } = options;
	let managed = options.managed === true;
	let readyMs = options.readyMs ?? READY_MS;
	let maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
	let replaceMs = options.replaceMs ?? REPLACE_MS;
	let checkMs = options.checkMs ?? CHECK_MS;
	let recentMs = options.recentMs ?? RECENT_MS;
	let memory = options.memory ?? MEMORY;
	let check = options.check ?? (async () => "ok");
	let key = JSON.stringify(command);
	let values = Object.values(options.env ?? {});
	type Entry = {
		repository: string;
		checkout: string;
		/** A registered checkout's, which is a candidate however long ago it was served. */
		registered: boolean;
		/** Its place among the registered checkouts, which orders those never served. */
		order: number;
		/** When a Planner last started in it here, 0 for never. */
		served: number;
		spare?: Spare;
		ready: boolean;
		/** A start is under way, before its process is there. */
		starting: boolean;
		/** Counts the times its spare was let go: a start from before one goes too. */
		epoch: number;
		since: number;
		attempt: number;
		timer?: ReturnType<typeof setTimeout>;
		/** When the command was found not to take spare mode. */
		unsupported?: number;
		/** Since when its start waits for memory. */
		memory?: number;
		/** Chopin's last word on whether the machine can push to it, and when. */
		checked?: { answer: string; at: number };
		/** Since when Chopin refuses the machine a token for it: no spare until it says otherwise. */
		refused?: number;
	};
	let entries = new Map<string, Entry>();
	let add = (repository: string, checkout: string, registered: boolean, served = 0) => {
		let entry: Entry = {
			repository,
			checkout,
			registered,
			order: entries.size,
			served,
			ready: false,
			starting: false,
			epoch: 0,
			since: Date.now(),
			attempt: 0,
		};
		entries.set(repository.toLowerCase(), entry);
		return entry;
	};
	for (let [repository, checkout] of Object.entries(options.registered)) {
		if (repository) add(repository, checkout, true);
	}
	/** A clone the machine made of `repository`, by its real path, when it is there. */
	let cloneOf = (repository: string) => {
		if (!REPOSITORY.test(repository)) return undefined;
		let path = clonePath(directory, repository);
		if (!existsSync(join(path, ".git"))) return undefined;
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	};
	let stopped = false;
	let pending = new Set<Promise<unknown>>();
	let track = <T>(work: Promise<T>) => {
		pending.add(work);
		void work.finally(() => pending.delete(work));
		return work;
	};
	// One change to the record at a time, each to what the last one wrote.
	let writing: Promise<unknown> = Promise.resolve();
	let update = (change: (record: SpareRecord) => SpareRecord) => {
		writing = writing.then(async () => writeRecord(directory, change(await readRecord(directory))))
			.catch(() => {});
		return track(writing);
	};
	/** Keep when `repository` was served, and forget the repositories served too long ago. */
	let remember = (repository: string, at: number | undefined) =>
		update(record => {
			let served = Object.fromEntries(
				Object.entries(record.served ?? {}).filter(([name, when]) =>
					name.toLowerCase() !== repository.toLowerCase() && Date.now() - when < recentMs
				),
			);
			if (at !== undefined) served[repository] = at;
			return { ...record, served };
		});
	let bound = () => spareBound(memory().total, options.cap ?? MAX_SPARES);
	/** The entries that keep a spare: the most recently served, registered ones after, to the bound. */
	let wanted = () =>
		new Set(
			[...entries.values()]
				.filter(entry =>
					entry.refused === undefined
					&& (entry.registered || Date.now() - entry.served < recentMs)
				)
				.sort((a, b) => b.served - a.served || a.order - b.order)
				.slice(0, bound()),
		);
	let publish = () =>
		void options.states?.record(
			[...wanted()].map(entry => ({
				repository: entry.repository,
				state: options.off
					? "off"
					: entry.unsupported
					? "unsupported"
					: entry.ready
					? "ready"
					: entry.memory
					? "memory"
					: "starting",
				since: entry.unsupported ?? entry.memory ?? entry.since,
				command: basename(command[0] ?? ""),
			} satisfies SpareState)),
		);
	let dim = (text: string) => output.say(output.style.dim(text));
	let later = (entry: Entry, ms: number) => {
		if (stopped) return;
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			ensure(entry);
		}, ms);
		entry.timer.unref?.();
	};
	/** Let go of `entry`'s spare, or its start under way, and of its wait for the next. */
	let release = (entry: Entry) => {
		entry.epoch++;
		clearTimeout(entry.timer);
		entry.timer = undefined;
		let spare = entry.spare;
		entry.spare = undefined;
		entry.ready = false;
		if (spare) void track(spare.discard());
	};
	/**
	 * Start the spares the wanted entries lack, `delay` from now where given, and let go of the
	 * others'.
	 */
	let plan = (delay = 0) => {
		if (stopped) return;
		let want = wanted();
		for (let entry of entries.values()) {
			if (!want.has(entry) && (entry.spare || entry.starting || entry.timer)) release(entry);
		}
		for (let entry of want) {
			if (entry.spare || entry.starting || entry.timer) continue;
			if (delay) later(entry, delay);
			else ensure(entry);
		}
		publish();
	};
	/** Entries with a spare, or one starting. */
	let busy = () => [...entries.values()].filter(entry => entry.spare || entry.starting).length;
	/** Set once the slots a connector left are gone: no spare starts before. */
	let settled = false;
	let ensure = (entry: Entry) => {
		if (stopped || options.off || !settled || entry.spare || entry.starting || entry.timer) return;
		// A command found not to take spare mode is offered it again by the next connector.
		if (entry.unsupported !== undefined) return;
		if (!wanted().has(entry) || busy() >= bound()) return;
		entry.starting = true;
		entry.ready = false;
		entry.since = Date.now();
		publish();
		void track(
			start(entry).catch(() => {}).finally(() => {
				entry.starting = false;
				// What it started, or let go of, may let another start.
				plan();
			}),
		);
	};
	/** Chopin refuses the machine a token for `entry`'s repository: no spare for it, now or later. */
	let refuse = (entry: Entry) => {
		entry.refused = Date.now();
		entry.checked = undefined;
		release(entry);
		void remember(entry.repository, undefined);
		// A clone's entry goes; a registered checkout's is asked about again.
		if (!entry.registered) entries.delete(entry.repository.toLowerCase());
		plan();
	};
	/** Whether Chopin would give a token for `entry`'s repository now, asked unless known. */
	let pushes = async (entry: Entry) => {
		let known = entry.checked;
		if (known?.answer === "ok" && Date.now() - known.at < checkMs) return "ok";
		let answer = await check(entry.repository).catch(() => "unknown");
		entry.checked = { answer, at: Date.now() };
		return answer;
	};

	let start = async (entry: Entry) => {
		let epoch = entry.epoch;
		let current = () =>
			!stopped && entry.epoch === epoch
			&& entries.get(entry.repository.toLowerCase()) === entry;
		let pushing = await pushes(entry);
		if (!current()) return;
		if (pushing !== "ok") {
			if (pushing === "unknown") later(entry, backoff(entry.attempt++));
			else refuse(entry);
			return;
		}
		// Room for its microVM and what it loads, beside what the machine keeps available.
		if (memory().available < SPARE_BYTES + RESERVE_BYTES) {
			entry.memory ??= Date.now();
			publish();
			later(entry, MEMORY_WAIT_MS);
			return;
		}
		entry.memory = undefined;
		let identity = await commandIdentity(command).catch(() => "");
		let refused = (await readRecord(directory)).unsupported?.[key];
		if (refused && refused.identity === identity && Date.now() - refused.at < UNSUPPORTED_MS) {
			entry.unsupported = refused.at;
			publish();
			return;
		}
		entry.unsupported = undefined;
		if (!current()) return;
		let parent = await plannerFolder(directory, entry.repository);
		let slot = join(parent, `spare-${randomBytes(6).toString("hex")}`);
		let tokens = tokenFolder(slot);
		let head: string;
		// Its disk is held from its making until the spare stops, so no sweep removes it under it.
		let releaseDisk: () => Promise<void> = async () => {};
		try {
			releaseDisk = await holdDisk(plannerDisk(slot));
			await mkdir(tokens, { recursive: true, mode: 0o700 });
			await writeFile(plannerServer(slot), `${options.url}\n`, { mode: 0o600 });
			await options.sandbox.makeDisk?.(plannerDisk(slot));
			head = String((await gitAsync(["rev-parse", "HEAD"], { cwd: entry.checkout })).stdout).trim();
		} catch (error) {
			await removeSlot(slot);
			await releaseDisk();
			if (!current()) return;
			dim(
				`… Couldn't make a spare Planner's disk for ${entry.repository} (${
					redacted(error instanceof Error ? error.message : String(error)).split("\n")[0]
				}); new documents' Planners start as before.`,
			);
			later(entry, backoff(entry.attempt++));
			return;
		}
		if (!current()) {
			await removeSlot(slot);
			await releaseDisk();
			return;
		}
		let spare: Spare;
		try {
			spare = spawnSpare(
				{ ...options, values, managed },
				entry,
				slot,
				tokens,
				head,
				identity,
				releaseDisk,
			);
		} catch (error) {
			await removeSlot(slot);
			await releaseDisk();
			dim(
				`… Couldn't start a spare Planner for ${entry.repository} (${
					error instanceof Error ? error.message : String(error)
				}).`,
			);
			later(entry, backoff(entry.attempt++));
			return;
		}
		entry.spare = spare;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let ready = await Promise.race([
			(spare as Spare & { ready: Promise<boolean> }).ready,
			new Promise<false>(resolve => {
				timer = setTimeout(() => resolve(false), readyMs);
			}),
		]);
		clearTimeout(timer);
		if (entry.spare !== spare) return;
		if (ready && !stopped) {
			entry.ready = true;
			entry.since = Date.now();
			entry.attempt = 0;
			publish();
			let aged = setTimeout(() => {
				if (entry.spare !== spare) return;
				// Too old to be handed a document: a new one takes its place.
				entry.spare = undefined;
				entry.ready = false;
				void track(spare.discard());
				ensure(entry);
			}, maxAgeMs);
			aged.unref?.();
			void spare.exited.then(how => {
				clearTimeout(aged);
				if (entry.spare !== spare) return;
				entry.spare = undefined;
				entry.ready = false;
				if (stopped) return;
				dim(`… The spare Planner for ${entry.repository} exited (${how}); starting another.`);
				void track(spare.discard());
				later(entry, backoff(entry.attempt++));
			});
			return;
		}
		// Never ready: it doesn't take spare mode, or not now.
		entry.spare = undefined;
		let printed = (spare as Spare & { printed(): boolean }).printed();
		await spare.discard();
		if (stopped) return;
		if (printed) {
			// It took spare mode once, so this start failed, not the mode: tried again later.
			later(entry, backoff(entry.attempt++));
			return;
		}
		let at = Date.now();
		await update(record => ({
			...record,
			unsupported: { ...record.unsupported, [key]: { identity, at } },
		}));
		entry.unsupported = at;
		publish();
		dim(
			`… The Planner command didn't start as a spare (no ready line within ${
				Math.round(readyMs / 1000)
			}s), so new documents' Planners start as before.`,
		);
	};

	// The repositories served recently, then the slots a connector left that never got a document,
	// in every repository's Planner folder, go before any spare starts.
	let loaded = track(
		(async () => {
			let record = await readRecord(directory);
			for (let [repository, at] of Object.entries(record.served ?? {})) {
				if (typeof at !== "number" || Date.now() - at >= recentMs) continue;
				let known = entries.get(repository.toLowerCase());
				if (known) {
					known.served = Math.max(known.served, at);
					continue;
				}
				let checkout = cloneOf(repository);
				if (checkout) add(repository, checkout, false, at);
			}
			let planners = join(directory, "planners");
			let folders = async (path: string) =>
				(await readdir(path, { withFileTypes: true }).catch(() => []))
					.filter(item => item.isDirectory()).map(item => join(path, item.name));
			for (let owner of await folders(planners)) {
				for (let parent of await folders(owner)) {
					let assigned = await assignedSlots(parent);
					// A slot is its disk, token folder and agents' state, whichever are there.
					let slots = new Set(
						(await readdir(parent).catch(() => [] as string[]))
							.map(name => name.replace(/\.(disk|tokens|agent|server)$/, ""))
							.filter(name => SPARE_SLOT.test(name) && !assigned.has(name)),
					);
					for (let name of slots) await removeSlot(join(parent, name));
				}
			}
		})().catch(() => {}),
	);

	// Chopin's word on each repository whose spare is kept, and on registered checkouts it refused,
	// asked again now and then: a spare goes once the machine can't push there.
	let asking = false;
	let recheck = async () => {
		if (asking || stopped) return;
		asking = true;
		try {
			for (let entry of entries.values()) {
				if (stopped) return;
				if (!entry.spare && !entry.starting && entry.refused === undefined) continue;
				let answer = await check(entry.repository).catch(() => "unknown");
				if (stopped || entries.get(entry.repository.toLowerCase()) !== entry) continue;
				if (answer === "unknown") continue;
				entry.checked = { answer, at: Date.now() };
				if (answer !== "ok") {
					if (entry.refused === undefined) refuse(entry);
				} else if (entry.refused !== undefined) {
					entry.refused = undefined;
					plan();
				}
			}
		} finally {
			asking = false;
		}
	};
	let rechecking = setInterval(() => void recheck(), checkMs);
	rechecking.unref?.();

	let stop = async () => {
		stopped = true;
		clearInterval(rechecking);
		for (let entry of entries.values()) clearTimeout(entry.timer);
		await Promise.all(pending);
		await Promise.all(
			[...entries.values()].map(async entry => {
				let spare = entry.spare;
				entry.spare = undefined;
				entry.ready = false;
				await spare?.discard();
			}),
		);
		await writing;
		await options.states?.record([]);
	};
	let stopping: Promise<void> | undefined;
	options.signal.addEventListener("abort", () => void (stopping ??= stop()), { once: true });
	publish();
	void loaded.then(() => {
		settled = true;
		if (options.off) publish();
		else plan();
	});

	/** Replaces each spare that did not start as `managed` says, so the next one does. */
	let remake = () => {
		for (let entry of entries.values()) {
			let spare = entry.spare;
			if (!spare || spare.managed === managed) continue;
			entry.spare = undefined;
			entry.ready = false;
			void track(spare.discard());
			ensure(entry);
		}
		publish();
	};
	return {
		async take(repository, asked = false) {
			let entry = entries.get(repository.toLowerCase());
			let spare = entry?.spare;
			if (stopped || !entry || !spare || !entry.ready || !spare.alive()) return undefined;
			if (entry.refused !== undefined) return undefined;
			// One started otherwise is never handed such a document: it has, or lacks, the owner's setup.
			if (spare.managed !== asked) return undefined;
			entry.spare = undefined;
			entry.ready = false;
			entry.served = Date.now();
			void remember(entry.repository, entry.served);
			publish();
			let current = Date.now() - spare.started < maxAgeMs
				&& await commandIdentity(command).catch(() => "") === spare.identity;
			if (!current) {
				// A spare made by an older command, or too old, is never handed a document.
				void track(spare.discard());
				ensure(entry);
				return undefined;
			}
			later(entry, replaceMs);
			return spare;
		},
		served(repository) {
			if (stopped || !repository) return;
			let entry = entries.get(repository.toLowerCase());
			if (!entry) {
				let checkout = cloneOf(repository);
				if (!checkout) return;
				entry = add(repository, checkout, false);
			}
			// Chopin gave this Planner a token for it: the machine can push there.
			entry.served = Date.now();
			entry.refused = undefined;
			entry.checked = { answer: "ok", at: entry.served };
			void remember(entry.repository, entry.served);
			// Its spare starts once the Planner that just started has had the machine to itself.
			plan(replaceMs);
		},
		refused(repository) {
			let entry = entries.get(repository.toLowerCase());
			if (entry && !stopped) refuse(entry);
			else if (!stopped) void remember(repository, undefined);
		},
		stop: () => stopping ??= stop(),
		managed(value) {
			if (value === managed) return;
			managed = value;
			if (!stopped) remake();
		},
	};
}

/** Start one spare in `slot` through the sandbox, as a cold launch would start a document's. */
function spawnSpare(
	options: {
		url: string;
		command: string[];
		env?: Record<string, string>;
		sandbox: Sandbox;
		agentStore?: AgentStore;
		values: string[];
		managed: boolean;
	},
	entry: { repository: string; checkout: string },
	slot: string,
	tokens: string,
	head: string,
	identity: string,
	/** Lets go of its disk once it has stopped (see `holdDisk`). */
	releaseDisk: () => Promise<void>,
): Spare & { ready: Promise<boolean>; printed(): boolean } {
	// A spare a managed document will take starts as its cold launch would: nothing of the owner's
	// agent setup in its environment or in its sight.
	let inherited = plannerEnvironment(options.managed, slot, options.env, options.agentStore);
	for (let name of HANDED) delete inherited[name];
	let child = spawnIn(options.sandbox, {
		command: options.command,
		env: {
			...inherited,
			// Where its credentials will be: the files appear with its hand-over, never before.
			...githubPaths(join(tokens, "github"), join(tokens, "gh"), entry.repository),
			CHOPIN_URL: options.url,
			CHOPIN_CHECKOUT: entry.checkout,
			CHOPIN_WORKTREE: guestRepositoryPath(entry.repository, options.sandbox.work),
			CHOPIN_PLANNER_TOKEN_FILE: join(tokens, "planner"),
			CHOPIN_MCP_TOKEN_FILE: join(tokens, "mcp"),
			CHOPIN_PLANNER_SPARE: String(SPARE_PROTOCOL),
		},
		stdin: "pipe",
		...plannerGuest(slot, entry.checkout, entry.repository, options.managed, options.sandbox.work),
	});
	let hooks: { secrets: () => string[]; stderr?: (text: string) => void } = {
		secrets: () => options.values,
	};
	let printed = false;
	let isReady!: (ready: boolean) => void;
	let ready = new Promise<boolean>(resolve => isReady = resolve);
	let keep = (line: string) => {
		if (printed || line.replace(/\r$/, "") !== READY_LINE) return true;
		printed = true;
		isReady(true);
		return false;
	};
	let drained = Promise.all([
		passMasked(child.stdout, "stdout", () => hooks.secrets(), undefined, keep),
		passMasked(child.stderr, "stderr", () => hooks.secrets(), text => hooks.stderr?.(text)),
	]);
	let living = true;
	let exited = new Promise<string>(resolve => {
		child.once("error", error => resolve(error.message));
		child.once("exit", (code, name) => resolve(name ? `signal ${name}` : `exit ${code}`));
	});
	void exited.then(() => {
		living = false;
		isReady(false);
		// `nvx` exits once its microVM has.
		void releaseDisk();
	});
	let writable = true;
	child.stdin?.on("error", () => {
		writable = false;
	});
	let end = () => {
		writable = false;
		try {
			child.stdin?.end();
		} catch { /* Already closed. */ }
	};
	let stop = async () => {
		end();
		if (living) {
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, END_GRACE_MS))]);
		}
		// Its children go with it, as a backend's do.
		if (living || process.platform !== "win32") await stopBackend(child);
		await releaseDisk();
	};
	return {
		repository: entry.repository,
		checkout: entry.checkout,
		slot,
		tokens,
		child,
		started: Date.now(),
		identity,
		managed: options.managed,
		exited,
		ready,
		printed: () => printed,
		alive: () => living,
		listen(next) {
			hooks = next;
			return drained;
		},
		send(message) {
			if (!living || !writable || !child.stdin || child.stdin.destroyed) return false;
			let line = JSON.stringify(message);
			if (Buffer.byteLength(line) > LINE_BYTES) return false;
			child.stdin.write(`${line}\n`);
			return true;
		},
		async refresh() {
			let now = String((await gitAsync(["rev-parse", "HEAD"], { cwd: entry.checkout })).stdout)
				.trim();
			// Its repository is in its microVM, which the host never runs git in: a spare whose checkout
			// moved since it started is let go, and the document starts cold at the checkout's HEAD.
			if (now !== head) throw new Error("its checkout moved since it started");
		},
		stop,
		async discard() {
			await stop();
			await removeSlot(slot);
		},
	};
}
