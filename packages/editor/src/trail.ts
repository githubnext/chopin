/**
 * How long the reader has left to notice each thing the agent changed.
 *
 * A mark waits until it has been looked at. The agent can write below the fold
 * while somebody is reading the top of the plan, and a mark that spent its ten
 * seconds off screen would have told nobody anything — so nothing starts
 * counting down until it has been in the viewport, and until then it is an
 * unread marker rather than a flash. Unread markers do not expire on a clock;
 * that is the whole point of deferring them.
 *
 * Once seen the clock runs whether or not the mark is still in view. Two
 * states and one timer: a mark can never go dark and light up again on a later
 * scroll, which would read as a second edit that never happened.
 *
 * Nothing here knows what a mark looks like, where it is, or that there is a
 * document. It is the part worth testing and the part that does not need a
 * browser — the test runtime has neither a DOM nor a controllable clock, which
 * is also why the duration is an argument rather than a constant.
 */

/** How long a mark stays up once it has been seen. */
const LINGER = 10_000;

/**
 * How many unseen marks to keep.
 *
 * Unbounded, a long session in a plan the reader never scrolls through would
 * accumulate one for every block the agent ever wrote. The oldest go first:
 * what the agent did a moment ago is worth more than what it did an hour ago.
 */
const CAPACITY = 50;

export type Phase = "pending" | "showing";

export type Trail = {
	/** Take on marks. One already tracked keeps the phase it had. */
	add: (ids: string[]) => void;
	/** Report what is in the viewport. Anything newly seen starts its clock. */
	saw: (ids: Iterable<string>) => void;
	/** Give up on marks that no longer name anywhere. */
	drop: (ids: Iterable<string>) => void;
	phase: (id: string) => Phase | undefined;
	/** Every live mark, oldest first. */
	ids: () => string[];
	pending: () => string[];
	showing: () => string[];
	dispose: () => void;
};

/**
 * Track a set of marks through being seen and expiring.
 *
 * `changed` is called when a mark expires on its own, which is the only
 * transition nobody asked for and so the only one a caller cannot predict.
 */
export function trail(changed: () => void, linger = LINGER): Trail {
	// Insertion-ordered, which is what makes evicting the oldest a matter of
	// taking the first key rather than tracking arrival times.
	let phases = new Map<string, Phase>();
	let timers = new Map<string, ReturnType<typeof setTimeout>>();

	let stop = (id: string) => {
		let timer = timers.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		timers.delete(id);
	};

	let forget = (id: string) => {
		stop(id);
		phases.delete(id);
	};

	let of = (phase: Phase) => [...phases].flatMap(([id, held]) => held === phase ? [id] : []);

	return {
		add(ids) {
			for (let id of ids) {
				if (phases.has(id)) continue;
				phases.set(id, "pending");
			}
			while (phases.size > CAPACITY) {
				let oldest = phases.keys().next().value;
				if (oldest === undefined) break;
				forget(oldest);
			}
		},

		saw(ids) {
			for (let id of ids) {
				// Only the first sighting counts. Scrolling back to something
				// already showing must not buy it another ten seconds, or a
				// mark could be kept alive indefinitely by being looked at.
				if (phases.get(id) !== "pending") continue;
				phases.set(id, "showing");
				timers.set(
					id,
					setTimeout(() => {
						forget(id);
						changed();
					}, linger),
				);
			}
		},

		drop(ids) {
			for (let id of ids) forget(id);
		},

		phase: id => phases.get(id),
		ids: () => [...phases.keys()],
		pending: () => of("pending"),
		showing: () => of("showing"),

		dispose() {
			for (let timer of timers.values()) clearTimeout(timer);
			timers.clear();
			phases.clear();
		},
	};
}
