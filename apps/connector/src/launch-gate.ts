import { availableParallelism } from "node:os";

/**
 * How many Planner microVMs boot at once on this machine. A boot holds a slot from the moment its
 * launch begins (its disk made, its microVM started, its repository cloned in the guest) until its
 * workload starts, or it fails. A launch that finds every slot held waits: a document's Planner
 * before any spare, documents in the order they asked, spares in theirs; and a spare waits too while
 * any document's cold launch is on its way to the gate (`coming`). A slot that frees is
 * handed on at once, so no launch waits while one is free, and none is refused: a burst of new
 * documents starts as many cold Planners at once as the cap allows, then the next as each boots.
 */
export type LaunchGate = {
	/**
	 * Waits for a slot; resolves with its release, which may be called more than once. Rejects
	 * with the signal's reason if it ends first, and holds nothing then.
	 */
	acquire(kind: "document" | "spare", signal?: AbortSignal): Promise<() => void>;
	/**
	 * A document's cold launch is on its way to boot, its token and checkout still being fetched:
	 * no spare boots until it has, so a burst's cold starts never share the machine with its refill.
	 * Resolves nothing; call what it returns once the launch has booted or ended (more than once is
	 * once).
	 */
	coming(): () => void;
	/** Slots held, and launches waiting of each kind. */
	counts(): { held: number; documents: number; spares: number };
};

/** Half the machine's processors, at least 2 and at most 8: one boot keeps a processor busy. */
export function startCap(processors = availableParallelism()) {
	return Math.min(8, Math.max(2, Math.floor(processors / 2)));
}

export function launchGate(cap = startCap()): LaunchGate {
	type Waiter = { grant(release: () => void): void };
	let held = 0;
	/** Documents' cold launches on their way to boot. */
	let underway = 0;
	let waiting = { document: [] as Waiter[], spare: [] as Waiter[] };
	let slot = () => {
		held++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			held--;
			hand();
		};
	};
	let hand = () => {
		while (held < cap) {
			let next = waiting.document.shift() ?? (underway ? undefined : waiting.spare.shift());
			if (!next) return;
			next.grant(slot());
		}
	};
	return {
		acquire(kind, signal) {
			if (signal?.aborted) return Promise.reject(signal.reason);
			// Nobody waits while a slot is free, but a spare while a document is on its way.
			if (held < cap && (kind === "document" || !underway)) return Promise.resolve(slot());
			return new Promise((resolve, reject) => {
				let waiter: Waiter = {
					grant(release) {
						signal?.removeEventListener("abort", abort);
						resolve(release);
					},
				};
				let abort = () => {
					let list = waiting[kind];
					let at = list.indexOf(waiter);
					if (at >= 0) list.splice(at, 1);
					reject(signal!.reason);
				};
				signal?.addEventListener("abort", abort, { once: true });
				waiting[kind].push(waiter);
			});
		},
		coming() {
			underway++;
			let done = false;
			return () => {
				if (done) return;
				done = true;
				underway--;
				hand();
			};
		},
		counts: () => ({
			held,
			documents: waiting.document.length,
			spares: waiting.spare.length,
		}),
	};
}
