import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { redacted } from "./connection";
import { gitAsync } from "./git-host";
import { githubPaths, withoutGitHub } from "./github-token";
import type { Output } from "./output";
import { passMasked, stopBackend } from "./planner";
import { backoff } from "./reconnect";
import { type Sandbox, type Spawned, spawnIn } from "./sandbox";
import {
	assignedSlots,
	plannerFolder,
	preparePlannerWorktree,
	SPARE_SLOT,
	type SpareState,
	type SpareStates,
	tokenFolder,
} from "./workspace";

/**
 * Spare Planners: one Planner command per registered checkout's repository, started ahead in its
 * own sandbox with its code loaded, attached to nothing, so a new document's Planner only waits for
 * its hand-over and its attach instead of the command's whole start. The contract between the
 * connector and the command, spare protocol 1:
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
 * A spare is handed only a document with no Planner worktree on this machine yet; its slot becomes
 * that document's worktree for good (`assignSlot`). A replacement starts `replaceMs` after a
 * hand-over, so two never compete for the CPU while one attaches.
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
/** At most this many spares run on a machine: one each for its first registered checkouts. */
export const MAX_SPARES = 4;
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
	/** Detach its slot at the checkout's HEAD, on the host, when HEAD moved since it started. */
	refresh(): Promise<void>;
	/** End its stdin and stop its processes; its slot stays. */
	stop(): Promise<void>;
	/** Stop it and remove its slot: a spare that never got a document. */
	discard(): Promise<void>;
};

export type PlannerSpares = {
	/**
	 * The repository's spare, ready and current, taken out of the pool for one document; its
	 * replacement starts `replaceMs` later. Undefined when there is none to take: the document
	 * starts cold.
	 */
	take(repository: string): Promise<Spare | undefined>;
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

/** `<base>/planner-spare.json`: commands found not to take spare mode, by command line. */
type SpareRecord = { unsupported?: Record<string, { identity: string; at: number }> };

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

/** Remove a slot that never got a document: its linked worktree, its entry and its token folder. */
async function removeSlot(checkout: string, slot: string) {
	await gitAsync(["worktree", "remove", "--force", slot], { cwd: checkout }).catch(() => {});
	await rm(slot, { recursive: true, force: true });
	await rm(tokenFolder(slot), { recursive: true, force: true });
	await gitAsync(["worktree", "prune"], { cwd: checkout }).catch(() => {});
}

/**
 * The machine's spare Planners, for the repositories of its registered checkouts, while `signal`
 * lasts. With `off`, none starts, and status says so.
 */
export function plannerSpares(options: {
	url: string;
	command: string[];
	/** The registered checkouts, by repository: only these get a spare. */
	registered: Record<string, string>;
	directory: string;
	output: Output;
	signal: AbortSignal;
	env?: Record<string, string>;
	sandbox?: Sandbox;
	states?: SpareStates;
	off?: boolean;
	readyMs?: number;
	maxAgeMs?: number;
	replaceMs?: number;
}): PlannerSpares {
	let { output, directory, command } = options;
	let readyMs = options.readyMs ?? READY_MS;
	let maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
	let replaceMs = options.replaceMs ?? REPLACE_MS;
	let key = JSON.stringify(command);
	let values = Object.values(options.env ?? {});
	type Entry = {
		repository: string;
		checkout: string;
		spare?: Spare;
		ready: boolean;
		/** A start is under way, before its process is there. */
		starting: boolean;
		since: number;
		attempt: number;
		timer?: ReturnType<typeof setTimeout>;
		/** When the command was found not to take spare mode. */
		unsupported?: number;
	};
	let entries = new Map<string, Entry>(
		Object.entries(options.registered)
			.filter(([repository]) => repository)
			.slice(0, MAX_SPARES)
			.map(([repository, checkout]) => [
				repository.toLowerCase(),
				{ repository, checkout, ready: false, starting: false, since: Date.now(), attempt: 0 },
			]),
	);
	let stopped = false;
	let pending = new Set<Promise<unknown>>();
	let track = <T>(work: Promise<T>) => {
		pending.add(work);
		void work.finally(() => pending.delete(work));
		return work;
	};
	let publish = () =>
		void options.states?.record(
			[...entries.values()].map(entry => ({
				repository: entry.repository,
				state: options.off
					? "off"
					: entry.unsupported
					? "unsupported"
					: entry.ready
					? "ready"
					: "starting",
				since: entry.unsupported ?? entry.since,
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
	let ensure = (entry: Entry) => {
		if (stopped || options.off || entry.spare || entry.starting || entry.timer) return;
		entry.starting = true;
		entry.ready = false;
		entry.since = Date.now();
		publish();
		void track(
			start(entry).catch(() => {}).finally(() => {
				entry.starting = false;
			}),
		);
	};

	let start = async (entry: Entry) => {
		let identity = await commandIdentity(command).catch(() => "");
		let refused = (await readRecord(directory)).unsupported?.[key];
		if (refused && refused.identity === identity && Date.now() - refused.at < UNSUPPORTED_MS) {
			entry.unsupported = refused.at;
			publish();
			return;
		}
		entry.unsupported = undefined;
		let parent = await plannerFolder(directory, entry.repository);
		let slot = join(parent, `spare-${randomBytes(6).toString("hex")}`);
		let tokens = tokenFolder(slot);
		let head: string;
		try {
			await mkdir(tokens, { recursive: true, mode: 0o700 });
			if (!await preparePlannerWorktree(entry.checkout, slot)) {
				throw new Error(`${slot} holds files that are no worktree`);
			}
			head = String((await gitAsync(["rev-parse", "HEAD"], { cwd: entry.checkout })).stdout).trim();
		} catch (error) {
			await removeSlot(entry.checkout, slot);
			dim(
				`… Couldn't make a spare Planner's worktree for ${entry.repository} (${
					redacted(error instanceof Error ? error.message : String(error)).split("\n")[0]
				}); new documents' Planners start as before.`,
			);
			later(entry, backoff(entry.attempt++));
			return;
		}
		if (stopped) {
			await removeSlot(entry.checkout, slot);
			return;
		}
		let spare: Spare;
		try {
			spare = spawnSpare({ ...options, values }, entry, slot, tokens, head, identity);
		} catch (error) {
			await removeSlot(entry.checkout, slot);
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
		let record = await readRecord(directory);
		await writeRecord(directory, {
			...record,
			unsupported: { ...record.unsupported, [key]: { identity, at } },
		}).catch(() => {});
		entry.unsupported = at;
		publish();
		dim(
			`… The Planner command didn't start as a spare (no ready line within ${
				Math.round(readyMs / 1000)
			}s), so new documents' Planners start as before.`,
		);
	};

	// Slots a connector left that never got a document go before any spare starts.
	let cleared = track(
		(async () => {
			for (let entry of entries.values()) {
				let parent = await plannerFolder(directory, entry.repository);
				let assigned = await assignedSlots(parent);
				for (let name of await readdir(parent).catch(() => [] as string[])) {
					if (SPARE_SLOT.test(name) && !assigned.has(name)) {
						await removeSlot(entry.checkout, join(parent, name));
					}
				}
			}
		})().catch(() => {}),
	);

	let stop = async () => {
		stopped = true;
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
		await options.states?.record([]);
	};
	let stopping: Promise<void> | undefined;
	options.signal.addEventListener("abort", () => void (stopping ??= stop()), { once: true });
	publish();
	if (!options.off) void cleared.then(() => entries.forEach(entry => ensure(entry)));

	return {
		async take(repository) {
			let entry = entries.get(repository.toLowerCase());
			let spare = entry?.spare;
			if (stopped || !entry || !spare || !entry.ready || !spare.alive()) return undefined;
			entry.spare = undefined;
			entry.ready = false;
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
		stop: () => stopping ??= stop(),
	};
}

/** Start one spare in `slot` through the sandbox, as a cold launch would start a document's. */
function spawnSpare(
	options: {
		url: string;
		command: string[];
		env?: Record<string, string>;
		sandbox?: Sandbox;
		values: string[];
	},
	entry: { repository: string; checkout: string },
	slot: string,
	tokens: string,
	head: string,
	identity: string,
): Spare & { ready: Promise<boolean>; printed(): boolean } {
	let inherited = withoutGitHub({ ...process.env, ...options.env });
	for (let name of HANDED) delete inherited[name];
	let child = spawnIn(options.sandbox, {
		command: options.command,
		cwd: entry.checkout,
		env: {
			...inherited,
			// Where its credentials will be: the files appear with its hand-over, never before.
			...githubPaths(join(tokens, "github"), join(tokens, "gh"), entry.repository),
			CHOPIN_URL: options.url,
			CHOPIN_CHECKOUT: entry.checkout,
			CHOPIN_WORKTREE: slot,
			CHOPIN_PLANNER_TOKEN_FILE: join(tokens, "planner"),
			CHOPIN_MCP_TOKEN_FILE: join(tokens, "mcp"),
			CHOPIN_PLANNER_SPARE: String(SPARE_PROTOCOL),
		},
		stdin: "pipe",
		writable: [slot],
		own: [slot, tokens],
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
	};
	return {
		repository: entry.repository,
		checkout: entry.checkout,
		slot,
		tokens,
		child,
		started: Date.now(),
		identity,
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
			if (now === head) return;
			// Its worktree is untouched: detached at the checkout's HEAD now, files and all.
			await gitAsync(["checkout", "--quiet", "--detach", now], { cwd: slot, noFilters: true });
			head = now;
		},
		stop,
		async discard() {
			await stop();
			await removeSlot(entry.checkout, slot);
		},
	};
}
