/**
 * Who is writing in a document's Chat and its threads, as Slack shows it: presence, never saved.
 *
 * Each connection holds its own intent in each place (Chat, or a thread by its root), the newest by
 * the connection's own `seq`, so an older, repeated or reordered report changes nothing and one tab
 * stopping never hides another still writing. The newest number is kept for as long as the
 * connection is open, even once what it reported is no longer shown, so no old report brings anyone
 * back. A report says when the edit it reports was made, on the server's clock (`at`, which its
 * client places by the `now` of its connection's `session:hello`: never later than the edit was, and
 * earlier by that hello's transit at most). It is visible until five seconds after that edit, so a
 * client that never stops, a report delivered again or one held on its way never outlasts the edit
 * it carries: one that arrives five seconds or more after its edit shows no one and changes nothing,
 * and so does one placed past the server's clock by more than `TYPING_SKEW_MS`. One person's reports
 * that start or renew writing in one place show them again once in 1.5 seconds at most, a little
 * under the composer's two, so a report early by jitter is not refused: one that would show a person
 * again sooner is shown when the interval is up, and every report keeps its own edit's deadline,
 * whichever tab of the person's sent it. Stopping is never limited. The Planner is writing in a place
 * while a turn there writes its reply.
 *
 * Access is asked afresh, never taken from a grant held since the socket was admitted: before a
 * roster names a person, whether their connection can still write (one that can't, or can't be
 * confirmed, stops writing everywhere); and before a member is told a roster, on joining too,
 * whether they can still read, readers included. A roster is told without its viewer. A member whose
 * access can't be confirmed for now is asked again, and told the newest roster once it is.
 */
import { tell } from "../wire";
import { actor } from "./initiative";

import type { Chat as Wire } from "@chopin/protocol";
import type { AuthorizationResult, Socket } from "../wire";
import type { InitiativeClock } from "./initiative-schedule";
import type { Room } from "./service";

/** The fewest milliseconds between two times one person is shown again in one place. */
export const TYPING_START_INTERVAL_MS = 1_500;
/** How long after its edit, on the server's clock, a report shows its writer. */
export const TYPING_IDLE_MS = 5_000;
/**
 * How far past the server's clock a report may place its edit and still be taken, as made now: the
 * client's clock gaining on the server's since its connection's hello. Beyond it, it is refused.
 */
export const TYPING_SKEW_MS = 1_000;
/** How long a member whose access couldn't be confirmed waits before it is asked again. */
export const TYPING_RECHECK_MS = 2_000;
const MAX_INTENTS = 64;
const MAX_PLACE_FLOORS = 64;
const CHAT_PLACE = "";

let lastGeneration = 0;

const systemClock: InitiativeClock = {
	now: Date.now,
	set: (callback, delay) => setTimeout(callback, delay),
	clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** One connection's latest word in one place. */
type Intent = {
	client: string;
	actor: string;
	handle: string;
	place: string;
	seq: number;
	/** When the writing its edit evidences ends. */
	until: number;
	/** Taken, but not yet shown: its person may be shown again once their interval is up. */
	held: boolean;
};

/**
 * The newest report a live connection has made, kept for as long as it is open, apart from what is
 * shown: in each place it last reported in, and past those, the newest of the places it no longer
 * keeps, which its single counter has already passed.
 */
type Floor = { base: number; places: Map<string, number> };

type Shown = { key?: string; actor?: string; typist: Wire.Typist };

function intentKey(client: string, place: string): string {
	return `${client}\n${place}`;
}

function personKey(actor: string, place: string): string {
	return `${actor}\n${place}`;
}

function visible(intent: Intent, now: number): boolean {
	return !intent.held && intent.until > now;
}

/** A check's answer, a check that throws being one that couldn't be confirmed. */
async function ask(check: () => Promise<AuthorizationResult>): Promise<AuthorizationResult> {
	try {
		return await check();
	} catch {
		return "unavailable";
	}
}

export type TypingReport = { active: boolean; thread?: unknown; seq?: unknown; at?: unknown };

export type TypingPresence = {
	/** A composer's report, from one connection of one person, bound to that connection. */
	type(client: string, actor: string, handle: string, report: TypingReport): void;
	/** A message sent in a place ends its connection's writing there, whatever its reports said. */
	sent(client: string, thread: unknown): void;
	/** A connection lost write access: what it was writing ends everywhere, and its numbers stand. */
	retire(client: string): void;
	/** A connection closed: what it was writing ends, and nothing else does. */
	depart(client: string): void;
	/** Whether the Planner's `turn` is writing its reply in Chat (`thread` absent) or a thread. */
	composing(thread: string | undefined, turn: string, writing: boolean): void;
	/** A member who joined is told who is writing now, once their access is confirmed. */
	greet(member: Socket): void;
	close(): void;
};

export function createTypingPresence(options: {
	/** Whether a thread's root is a message of this Chat. */
	threadExists(rootId: string): boolean;
	/** Everyone with the document open: who is told, while they can read it. */
	members(): Iterable<Socket>;
	/** Whether a member can read the document now, asked afresh before each roster they are told. */
	reads(member: Socket): Promise<AuthorizationResult>;
	/** Whether a connection can write the document now, asked afresh before a roster names it. */
	writes(client: string): Promise<AuthorizationResult>;
	clock?: InitiativeClock;
}): TypingPresence {
	let time = options.clock ?? systemClock;
	let generation = lastGeneration = Math.max(time.now(), lastGeneration + 1);
	let intents = new Map<string, Intent>();
	let allowances = new Map<string, number>();
	let floors = new Map<string, Floor>();
	let since = new Map<string, number>();
	let agent = new Map<string, { turn: string; since: number }>();
	/** The roster last told, and its number. */
	let roster: Shown[] = [];
	let seq = 0;
	let told = JSON.stringify([]);
	/** Whether what is shown may have changed since the roster last told was settled. */
	let dirty = false;
	let publishing = false;
	/** Members owed the newest roster, those whose access is being asked, and those to ask again. */
	let owed = new Set<Socket>();
	let checking = new Set<Socket>();
	let rechecks = new Map<Socket, unknown>();
	let timer: unknown;
	let closed = false;

	function place(thread: unknown): string | undefined {
		if (thread === undefined) return CHAT_PLACE;
		if (typeof thread !== "string" || !thread || thread.length > 128) return undefined;
		return options.threadExists(thread) ? thread : undefined;
	}

	function release(now: number) {
		for (let intent of intents.values()) {
			if (!intent.held) continue;
			let allowed = allowances.get(personKey(intent.actor, intent.place));
			if (allowed !== undefined && now - allowed < TYPING_START_INTERVAL_MS) continue;
			intent.held = false;
			if (intent.until > now) allowances.set(personKey(intent.actor, intent.place), now);
		}
	}

	/** Who is writing at `now`: of the people, only those whose connection is in `writers`. */
	function shown(now: number, writers?: ReadonlySet<string>): Shown[] {
		let people = new Map<string, Shown>();
		for (let intent of intents.values()) {
			if (!visible(intent, now) || (writers && !writers.has(intent.client))) continue;
			let key = personKey(intent.actor, intent.place);
			if (people.has(key)) continue;
			people.set(key, {
				key,
				actor: intent.actor,
				typist: {
					author: { kind: "member", handle: intent.handle },
					...(intent.place ? { thread: intent.place } : {}),
					since: since.get(key) ?? now,
				},
			});
		}
		let writing = [...people.values()];
		for (let [where, composing] of agent) {
			writing.push({
				typist: {
					author: { kind: "agent" },
					...(where ? { thread: where } : {}),
					since: composing.since,
				},
			});
		}
		return writing.sort((a, b) => a.typist.since - b.typist.since);
	}

	function settle() {
		if (closed) return;
		let now = time.now();
		release(now);
		if (timer !== undefined) time.clear(timer);
		timer = undefined;
		let next = Infinity;
		for (let intent of intents.values()) {
			if (intent.held) {
				let allowed = allowances.get(personKey(intent.actor, intent.place)) ?? now;
				next = Math.min(next, allowed + TYPING_START_INTERVAL_MS);
			} else if (intent.until > now) next = Math.min(next, intent.until);
		}
		if (next !== Infinity) {
			timer = time.set(() => {
				timer = undefined;
				settle();
			}, Math.max(1, next - now));
		}
		if (!publishing && JSON.stringify(shown(now)) === told) return;
		dirty = true;
		void publish();
	}

	/**
	 * Tell the room who is writing once it changes: everyone shown writing is asked first whether
	 * they still can, and whoever can't, or can't be confirmed, stops writing everywhere. A writer who
	 * began while that was asked waits for the next round.
	 */
	async function publish() {
		if (publishing) return;
		publishing = true;
		try {
			while (dirty) {
				dirty = false;
				if (closed) return;
				let writers = new Set<string>();
				let now = time.now();
				for (let intent of intents.values()) if (visible(intent, now)) writers.add(intent.client);
				let asked = [...writers];
				let answers = await Promise.all(asked.map(client => ask(() => options.writes(client))));
				if (closed) return;
				asked.forEach((client, index) => {
					if (answers[index] === "allowed") return;
					writers.delete(client);
					drop(client);
				});
				now = time.now();
				for (let intent of intents.values()) {
					if (visible(intent, now) && !writers.has(intent.client)) dirty = true;
				}
				let writing = shown(now, writers);
				let snapshot = JSON.stringify(writing);
				if (snapshot === told) continue;
				told = snapshot;
				roster = writing;
				since = new Map(
					writing.flatMap(item => item.key ? [[item.key, item.typist.since] as const] : []),
				);
				seq++;
				for (let member of options.members()) deliver(member);
			}
		} finally {
			publishing = false;
		}
	}

	/** Owe `member` the newest roster, told once their access to read is confirmed. */
	function deliver(member: Socket) {
		if (closed || member.data.closed) return;
		owed.add(member);
		if (!checking.has(member) && !rechecks.has(member)) void confirm(member);
	}

	/**
	 * Ask whether `member` can read, then tell them the roster as it was when that was asked. A
	 * roster told meanwhile is owed after it, through another check.
	 */
	async function confirm(member: Socket) {
		checking.add(member);
		try {
			while (owed.delete(member)) {
				if (closed || member.data.closed) break;
				let frame = frameOf(actor(member));
				let access = await ask(() => options.reads(member));
				if (closed || member.data.closed) break;
				if (access === "unavailable") {
					owed.add(member);
					rechecks.set(
						member,
						time.set(() => {
							rechecks.delete(member);
							if (!checking.has(member)) void confirm(member);
						}, TYPING_RECHECK_MS),
					);
					break;
				}
				if (access === "allowed") tell(member, frame);
			}
		} finally {
			checking.delete(member);
			if (closed || member.data.closed) forget(member);
		}
	}

	function forget(member: Socket) {
		owed.delete(member);
		let recheck = rechecks.get(member);
		if (recheck !== undefined) time.clear(recheck);
		rechecks.delete(member);
	}

	function frameOf(viewer: string): Wire.Typists {
		return {
			kind: "chat:typists",
			ts: 0,
			generation,
			seq,
			typists: roster.filter(item => item.actor !== viewer).map(item => item.typist),
		};
	}

	function newest(client: string, where: string): number {
		let floor = floors.get(client);
		return floor?.places.get(where) ?? floor?.base ?? -Infinity;
	}

	function reported(client: string, where: string, order: number) {
		let floor = floors.get(client);
		if (!floor) floors.set(client, floor = { base: -Infinity, places: new Map() });
		floor.places.delete(where);
		floor.places.set(where, order);
		if (floor.places.size <= MAX_PLACE_FLOORS) return;
		let [oldest, at] = floor.places.entries().next().value!;
		floor.places.delete(oldest);
		floor.base = Math.max(floor.base, at);
	}

	/** End what `client` was writing everywhere, leaving its numbers; whether anything ended. */
	function drop(client: string): boolean {
		let ended = false;
		for (let [key, intent] of intents) {
			if (intent.client !== client) continue;
			intents.delete(key);
			ended = true;
		}
		return ended;
	}

	function retire(client: string) {
		if (drop(client)) settle();
	}

	function room(key: string): boolean {
		if (intents.has(key) || intents.size < MAX_INTENTS) return true;
		let now = time.now();
		for (let [other, intent] of intents) {
			if (intent.until <= now) {
				intents.delete(other);
				return true;
			}
		}
		return false;
	}

	return {
		type(client, actor, handle, report) {
			if (closed) return;
			let where = place(report.thread);
			let order = report.seq;
			if (where === undefined || typeof order !== "number" || !Number.isSafeInteger(order)) return;
			let at = report.at;
			if (report.active && (typeof at !== "number" || !Number.isFinite(at))) return;
			let key = intentKey(client, where);
			if (order <= newest(client, where)) return;
			reported(client, where, order);
			if (!report.active) {
				if (intents.delete(key)) settle();
				return;
			}
			let now = time.now();
			let edited = at as number;
			// An edit placed past the server's clock by more than the skew can't be placed, and one
			// five seconds old has ended: neither shows anyone nor changes what was shown.
			if (edited > now + TYPING_SKEW_MS) return;
			let until = Math.min(edited, now) + TYPING_IDLE_MS;
			if (until <= now || !room(key)) return;
			let person = personKey(actor, where);
			let allowed = allowances.get(person);
			let intent: Intent = {
				client,
				actor,
				handle,
				place: where,
				seq: order,
				until,
				held: false,
			};
			let showing = [...intents.values()].some(other =>
				other.actor === actor && other.place === where && visible(other, now)
			);
			if (allowed === undefined || now - allowed >= TYPING_START_INTERVAL_MS) {
				allowances.set(person, now);
			} else if (!showing) intent.held = true;
			intents.set(key, intent);
			settle();
		},
		sent(client, thread) {
			let where = place(thread);
			if (where === undefined || !intents.delete(intentKey(client, where))) return;
			settle();
		},
		retire,
		depart(client) {
			floors.delete(client);
			for (let member of [...owed, ...rechecks.keys()]) {
				if (member.data.client === client) forget(member);
			}
			retire(client);
		},
		composing(thread, turn, writing) {
			if (closed) return;
			let where = thread ?? CHAT_PLACE;
			let current = agent.get(where);
			if (writing) {
				if (current?.turn === turn) return;
				agent.set(where, { turn, since: time.now() });
			} else {
				if (current?.turn !== turn) return;
				agent.delete(where);
			}
			settle();
		},
		greet(member) {
			deliver(member);
		},
		close() {
			closed = true;
			if (timer !== undefined) time.clear(timer);
			timer = undefined;
			for (let recheck of rechecks.values()) time.clear(recheck);
			rechecks.clear();
			owed.clear();
			intents.clear();
			allowances.clear();
			floors.clear();
			since.clear();
			agent.clear();
		},
	};
}

/** A composer's `chat:typing`: what Chat shows of who is writing, and nothing else. */
export function typed(context: Room, ws: Socket, report: TypingReport): void {
	context.chat.typists?.type(ws.data.client, actor(ws), ws.data.handle, report);
}
