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
 *
 * The agent's label stays up ten times as long. A person's caret is one of
 * several and its owner is watching it, so a second is enough to say who moved
 * where; the agent's arrives unannounced in a document somebody else is
 * reading, and the whole reason it is drawn at all is to say what put it
 * there. Naming it for one second and going quiet answers a question nobody
 * had time to ask.
 */

import type { Binding, Provider } from "@lexical/yjs";

/** How long a label stays up after its peer stops moving. */
const LINGER = 1000;

/** How long the agent's stays, for the same reason it is louder at all. */
const AGENT_LINGER = 10_000;

export type Labels = {
	/** Flashes whoever moved. Call after cursors are painted. */
	sync: () => void;
	dispose: () => void;
};

export function labels(
	binding: Binding,
	provider: Provider,
	linger = LINGER,
	agentLinger = AGENT_LINGER,
): Labels {
	/*
	 * Read from awareness rather than from the cursor, which only carries a
	 * name and a colour. Matching on the name would be the obvious shortcut
	 * and is wrong: handles are GitHub logins, `github.com/ai` is a real
	 * account, and somebody signing in as that would get the agent's chrome.
	 */
	let agent = (client: number): boolean =>
		provider.awareness.getStates().get(client)?.agent === true;

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
					}, agent(client) ? agentLinger : linger),
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
