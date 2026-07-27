/**
 * What survives a restart.
 *
 * The plan itself is canonical MDX on disk — readable, diffable, and editable
 * with an ordinary editor when something has gone wrong. Everything else the
 * room needs to resume sits beside it as JSON.
 *
 * Yjs history is deliberately not persisted. It is a binary format that buys
 * only undo across a restart, and carrying it would mean a stale checkpoint
 * could resurrect content the MDX no longer has. A restart starts a fresh
 * epoch from the source, which is a boundary clients already handle.
 *
 * Writes are debounced: an idle gap so a pause in typing is durable quickly,
 * and a ceiling so continuous typing cannot postpone durability forever.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Idle gap before a change is written. */
const IDLE_MS = 500;

/** Longest continuous editing may postpone a write. */
const MAX_MS = 2_000;

export type State = {
	/** Bumped on every committed mutation; the agent's concurrency token. */
	revision: number;
};

export type Stored = {
	source: string;
	state: State;
};

export type Sink = {
	/** Note that something changed, and schedule a write. */
	touch(): void;
	/** Write now and wait for it. Used on shutdown and before eviction. */
	flush(): Promise<void>;
	/** Stop scheduling. Does not write. */
	cancel(): void;
};

export type SinkOptions = {
	dir: string;
	/** Read the current state at write time, not at schedule time. */
	read: () => Stored;
	onWrite?: (state: "saving" | "saved" | "error", message?: string) => void;
};

function paths(dir: string) {
	return { source: join(dir, "plan.mdx"), state: join(dir, "state.json") };
}

export async function load(dir: string): Promise<Stored | undefined> {
	let file = paths(dir);

	let source: string;
	try {
		source = await readFile(file.source, "utf8");
	} catch {
		return undefined;
	}

	let state: State = { revision: 0 };
	try {
		state = { ...state, ...JSON.parse(await readFile(file.state, "utf8")) as Partial<State> };
	} catch {
		// A plan with no sidecar is still a plan. Losing the revision counter
		// costs the agent one rejected batch, not the document.
	}

	return { source, state };
}

/**
 * Write both files, source last.
 *
 * Ordering matters on a crash: state.json describing a revision the MDX has
 * not reached yet is recoverable, while MDX ahead of its state is not. Both go
 * through a temporary file so a reader never sees a half-written plan.
 */
async function write(dir: string, stored: Stored): Promise<void> {
	let file = paths(dir);
	await mkdir(dir, { recursive: true });

	await writeFile(`${file.state}.tmp`, `${JSON.stringify(stored.state, null, "\t")}\n`);
	await rename(`${file.state}.tmp`, file.state);

	await writeFile(`${file.source}.tmp`, stored.source);
	await rename(`${file.source}.tmp`, file.source);
}

export function sink(options: SinkOptions): Sink {
	let idle: ReturnType<typeof setTimeout> | undefined;
	let ceiling: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	/** Writes are serialised, so a slow disk cannot interleave two of them. */
	let writing: Promise<void> = Promise.resolve();

	function clear(): void {
		if (idle) clearTimeout(idle);
		if (ceiling) clearTimeout(ceiling);
		idle = undefined;
		ceiling = undefined;
	}

	function commit(): Promise<void> {
		clear();
		if (!dirty) return writing;
		dirty = false;

		writing = writing.then(async () => {
			let stored = options.read();

			// An empty plan is not worth a directory. Room names come from URLs,
			// so a typo would otherwise leave a permanent trace on disk.
			if (!stored.source.trim() && stored.state.revision === 0) return;

			try {
				await write(options.dir, stored);
				options.onWrite?.("saved");
			} catch (err) {
				options.onWrite?.("error", err instanceof Error ? err.message : String(err));
			}
		});

		return writing;
	}

	return {
		touch() {
			if (!dirty) options.onWrite?.("saving");
			dirty = true;
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => void commit(), IDLE_MS);
			ceiling ??= setTimeout(() => void commit(), MAX_MS);
		},

		flush() {
			return commit();
		},

		cancel() {
			clear();
			dirty = false;
		},
	};
}
