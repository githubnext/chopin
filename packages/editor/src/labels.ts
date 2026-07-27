/**
 * Remote cursor name labels.
 *
 * A label pinned over every caret buries the prose it is pointing at, and a
 * plan is read far more often than it is written. So a label appears when its
 * peer moves and fades once they settle, which is also how the document
 * editor behaves.
 *
 * Movement is read back from the caret's own rendered position rather than
 * from awareness. Awareness churns on a renewal timer whether or not anyone
 * moved; the painted position is the only thing that changes exactly when a
 * peer does.
 */

import type { Binding } from "@lexical/yjs";

/** How long a label stays up after its peer stops moving. */
const LINGER = 1000;

export type Labels = {
	/** Flashes whoever moved. Call after cursors are painted. */
	sync: () => void;
	dispose: () => void;
};

export function labels(binding: Binding, linger = LINGER): Labels {
	let seen = new Map<number, string>();
	let timers = new Map<number, ReturnType<typeof setTimeout>>();

	let stop = (client: number) => {
		let timer = timers.get(client);
		if (timer === undefined) return;
		clearTimeout(timer);
		timers.delete(client);
	};

	let forget = (client: number) => {
		seen.delete(client);
		stop(client);
	};

	return {
		sync() {
			for (let [client, cursor] of binding.cursors) {
				let caret = cursor.selection?.caret;
				if (!caret) {
					forget(client);
					continue;
				}

				let at = `${caret.style.left}|${caret.style.top}|${caret.style.height}`;
				let previous = seen.get(client);
				seen.set(client, at);
				// A peer appearing for the first time has no previous position
				// and so introduces itself, which is what we want.
				if (previous === at) continue;

				caret.dataset.planActive = "";
				stop(client);
				timers.set(
					client,
					setTimeout(() => {
						caret.removeAttribute("data-plan-active");
						timers.delete(client);
					}, linger),
				);
			}

			for (let client of seen.keys()) {
				if (!binding.cursors.has(client)) forget(client);
			}
		},

		dispose() {
			for (let timer of timers.values()) clearTimeout(timer);
			timers.clear();
			seen.clear();
		},
	};
}
