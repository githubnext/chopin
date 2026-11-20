import { PLANNER_NAME } from "@chopin/protocol/planner-name";

import type { Chat as Wire } from "@chopin/protocol";

/** Who the server last said is writing, as one snapshot: a later one replaces it. */
export type Typists = { generation: number; seq: number; typists: readonly Wire.Typist[] };

export type Typer = Wire.Typist["author"];

/**
 * The snapshot to keep once `frame` arrives: the newer of the two, by the room's generation and then
 * its `seq`, so a frame repeated or overtaken by a later one, or one from a room the server has
 * since opened again, changes nothing. A connection that closes forgets what it was told
 * (`undefined`), and the first snapshot of the next one is taken whatever its numbers.
 */
export function receiveTypists(current: Typists | undefined, frame: Wire.Typists): Typists {
	if (
		current && (frame.generation < current.generation
			|| (frame.generation === current.generation && frame.seq <= current.seq))
	) return current;
	return { generation: frame.generation, seq: frame.seq, typists: frame.typists };
}

/**
 * Who is shown writing in one place, Chat (`thread` absent) or a thread, in the order they began,
 * each once and never the viewer. The Planner is left out with `planner: false`, where something
 * else already shows it at work.
 */
export function typersIn(
	state: Typists | undefined,
	place: { thread?: string; viewer: string; planner?: boolean },
): Typer[] {
	let seen = new Set<string>();
	let shown: Typer[] = [];
	let here = (state?.typists ?? [])
		.filter(typist => typist.thread === place.thread)
		.toSorted((a, b) => a.since - b.since || nameOf(a.author).localeCompare(nameOf(b.author)));
	for (let { author } of here) {
		if (author.kind === "member" && author.handle === place.viewer) continue;
		if (author.kind === "agent" && place.planner === false) continue;
		let name = nameOf(author);
		if (seen.has(name)) continue;
		seen.add(name);
		shown.push(author);
	}
	return shown;
}

/** Every thread someone is writing in, but the viewer, with who in the order they began. */
export function threadsWithTypers(
	state: Typists | undefined,
	viewer: string,
): ReadonlyMap<string, Typer[]> {
	let threads = new Map<string, Typer[]>();
	for (let typist of state?.typists ?? []) {
		if (typist.thread === undefined || threads.has(typist.thread)) continue;
		let typers = typersIn(state, { thread: typist.thread, viewer });
		if (typers.length) threads.set(typist.thread, typers);
	}
	return threads;
}

function nameOf(author: Typer): string {
	return author.kind === "agent" ? PLANNER_NAME : `@${author.handle}`;
}

/**
 * The line Slack writes for who is writing: _@ana is typing…_, _@ana and @bo are typing…_, and
 * _Several people are typing…_ for three or more. `replying` is said of a thread from Chat.
 * Nobody is the empty string.
 */
export function typingWords(
	typers: readonly Typer[],
	verb: "typing" | "replying" = "typing",
): string {
	if (typers.length === 0) return "";
	if (typers.length === 1) return `${nameOf(typers[0]!)} is ${verb}…`;
	if (typers.length === 2) return `${nameOf(typers[0]!)} and ${nameOf(typers[1]!)} are ${verb}…`;
	return `Several people are ${verb}…`;
}
