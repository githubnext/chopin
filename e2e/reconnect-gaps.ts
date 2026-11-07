/**
 * What a tab's sockets did across a hand-over, and the gaps that follow from it. The page records
 * the events as they happen, each with the key of the socket that saw it; the pairing of a close
 * with its own reopening is done here, where a unit test can hold it.
 */
export type SocketEvent = {
	/** The page's own clock, in milliseconds. */
	at: number;
	/** The kind of socket: its path and the document it is for, never anything that changes. */
	key: string;
	/** `cut` is a close with 1012; `restarting` and `hello` are the frames of those names. */
	kind: "open" | "cut" | "restarting" | "hello";
};

export type SocketGap = {
	key: string;
	/** How many sockets of this kind the cut closed. */
	cuts: number;
	/** How many of them opened again. */
	reopened: number;
	/** From the first of the cut closes to the last of the reopenings; undefined while one is missing. */
	closeToOpenMs?: number;
	/** The `session:restarting` frames this kind of socket was sent. */
	restarts: number;
	/** The `session:hello` frames that came after the first of them. */
	hellos: number;
	/** Whether this kind of socket says hello at all: the document's does, the sidebar's does not. */
	greets: boolean;
	/** From the first restart frame to the last hello after it; undefined while one is missing. */
	restartToHelloMs?: number;
};

const byTime = (a: SocketEvent, b: SocketEvent) => a.at - b.at;

/**
 * The gaps of every kind of socket the cut closed. Sockets of one kind cannot be told apart, so
 * the first close is paired with the last opening: the gap of the slowest of them, whichever
 * order they came back in, and never less than the truth. A kind of its own per document keeps a
 * child's socket from standing in for its root's.
 */
export function reconnectGaps(events: SocketEvent[]): SocketGap[] {
	let gaps: SocketGap[] = [];
	for (let key of new Set(events.map(event => event.key))) {
		let mine = events.filter(event => event.key === key).sort(byTime);
		let cuts = mine.filter(event => event.kind === "cut");
		if (cuts.length === 0) continue;
		let closedAt = cuts[0]!.at;
		let reopened = mine.filter(event => event.kind === "open" && event.at >= closedAt).slice(
			0,
			cuts.length,
		);
		let restarts = mine.filter(event => event.kind === "restarting");
		let restartedAt = restarts[0]?.at;
		let hellos = restartedAt === undefined
			? []
			: mine.filter(event => event.kind === "hello" && event.at >= restartedAt).slice(
				0,
				restarts.length,
			);
		gaps.push({
			key,
			cuts: cuts.length,
			reopened: reopened.length,
			...(reopened.length === cuts.length
				? { closeToOpenMs: reopened.at(-1)!.at - closedAt }
				: {}),
			restarts: restarts.length,
			hellos: hellos.length,
			greets: mine.some(event => event.kind === "hello"),
			...(restartedAt !== undefined && hellos.length === restarts.length && hellos.length > 0
				? { restartToHelloMs: hellos.at(-1)!.at - restartedAt }
				: {}),
		});
	}
	return gaps;
}

/** Everything about the gaps that is wrong, one line each; empty when none is. */
export function reconnectProblems(gaps: SocketGap[], limitMs: number): string[] {
	let problems: string[] = [];
	for (let gap of gaps) {
		if (gap.reopened < gap.cuts) {
			problems.push(`${gap.key}: closed ${gap.cuts} time(s) and opened again ${gap.reopened}`);
		} else if (gap.closeToOpenMs! > limitMs) {
			problems.push(
				`${gap.key}: opened again ${gap.closeToOpenMs} ms after it closed, over the ${limitMs} ms allowed`,
			);
		}
		if (gap.greets && gap.restarts > 0 && gap.hellos < gap.restarts) {
			problems.push(
				`${gap.key}: ${gap.restarts} restart frame(s) and ${gap.hellos} hello(s) after them`,
			);
		} else if (gap.restartToHelloMs !== undefined && gap.restartToHelloMs > limitMs) {
			problems.push(
				`${gap.key}: hello came ${gap.restartToHelloMs} ms after the restart frame, over the ${limitMs} ms allowed`,
			);
		}
	}
	return problems;
}
