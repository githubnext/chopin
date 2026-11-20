/**
 * Who is writing in a document's Chat and its threads, as Slack shows it: presence, never saved.
 *
 * Each connection holds its own intent in each place (Chat, or a thread by its root), the newest by
 * the connection's own `seq`, so an older, repeated or reordered report changes nothing and one tab
 * stopping never hides another still writing. A report says how long ago the edit it reports was
 * made; it is visible until five seconds after that edit and a second for transit, so a client that
 * never stops, or a report delivered again, never outlasts the edit it carries. One person's reports
 * that start or renew writing in one place are taken once in 1.5 seconds at most, a little under the
 * composer's two, so a report early by jitter is not refused: a report beyond that
 * keeps no one longer than the last one taken, and one that would show a person again is shown when
 * the interval is up. Stopping is never limited. The Planner is writing in a place while a turn there
 * writes its reply. Everyone in the room is told the set when it changes, without themselves.
 */
import { tell } from "../wire";
import { actor, initiative } from "./initiative";

import type { Chat as Wire } from "@chopin/protocol";
import type { Socket } from "../wire";
import type { InitiativeClock } from "./initiative-schedule";
import type { Room } from "./service";

/** The fewest milliseconds between two reports one person makes in one place that start or renew. */
export const TYPING_START_INTERVAL_MS = 1_500;
/** How long after the edit a report carries its writer is shown, as their composer counts it. */
export const TYPING_IDLE_MS = 5_000;
/** What a report may have spent in transit, added to its writer's time. */
export const TYPING_TRANSIT_MS = 1_000;
/** The most a report may say its edit preceded it by: a composer reports at least that often. */
export const TYPING_REPORT_MS = 2_000;
const MAX_INTENTS = 64;
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
	active: boolean;
	/** When the writing its edit evidences ends. */
	until: number;
	/** Taken, but not yet shown: its person may be shown again once their interval is up. */
	held: boolean;
};

/** What one person's reports in one place were last allowed. */
type Allowance = { at: number; until: number };

type Shown = { actor?: string; typist: Wire.Typist };

function intentKey(client: string, place: string): string {
	return `${client}\n${place}`;
}

function personKey(actor: string, place: string): string {
	return `${actor}\n${place}`;
}

function visible(intent: Intent, now: number): boolean {
	return intent.active && !intent.held && intent.until > now;
}

export type TypingReport = { active: boolean; thread?: unknown; seq?: unknown; ago?: unknown };

export type TypingPresence = {
	/** A composer's report, from one connection of one person, bound to that connection. */
	type(client: string, actor: string, handle: string, report: TypingReport): void;
	/** A message sent in a place ends its connection's writing there, whatever its reports said. */
	sent(client: string, thread: unknown): void;
	/** A connection closed: what it was writing ends, and nothing else does. */
	depart(client: string): void;
	/** Whether the Planner's `turn` is writing its reply in Chat (`thread` absent) or a thread. */
	composing(thread: string | undefined, turn: string, writing: boolean): void;
	/** What one person is told: everyone writing but them. */
	frame(viewer: string): Wire.Typists;
	close(): void;
};

export function createTypingPresence(options: {
	/** Whether a thread's root is a message of this Chat. */
	threadExists(rootId: string): boolean;
	/** Everyone with the document open, who can all read it: who is told. */
	members(): Iterable<Socket>;
	clock?: InitiativeClock;
}): TypingPresence {
	let time = options.clock ?? systemClock;
	let generation = lastGeneration = Math.max(time.now(), lastGeneration + 1);
	let intents = new Map<string, Intent>();
	let allowances = new Map<string, Allowance>();
	let since = new Map<string, number>();
	let agent = new Map<string, { turn: string; since: number }>();
	let seq = 0;
	let told = "";
	let timer: unknown;
	let closed = false;

	function place(thread: unknown): string | undefined {
		if (thread === undefined) return CHAT_PLACE;
		if (typeof thread !== "string" || !thread || thread.length > 128) return undefined;
		return options.threadExists(thread) ? thread : undefined;
	}

	function release(now: number) {
		for (let intent of intents.values()) {
			if (!intent.active || !intent.held) continue;
			let allowance = allowances.get(personKey(intent.actor, intent.place));
			if (allowance && now - allowance.at < TYPING_START_INTERVAL_MS) continue;
			intent.held = false;
			if (intent.until > now) {
				allowances.set(personKey(intent.actor, intent.place), { at: now, until: intent.until });
			}
		}
	}

	function shown(now: number): Shown[] {
		let people = new Map<string, Shown>();
		for (let intent of intents.values()) {
			if (!visible(intent, now)) continue;
			let key = personKey(intent.actor, intent.place);
			if (people.has(key)) continue;
			people.set(key, {
				actor: intent.actor,
				typist: {
					author: { kind: "member", handle: intent.handle },
					...(intent.place ? { thread: intent.place } : {}),
					since: since.get(key) ?? now,
				},
			});
		}
		for (let key of since.keys()) if (!people.has(key)) since.delete(key);
		for (let [key, item] of people) if (!since.has(key)) since.set(key, item.typist.since);
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
		let writing = shown(now);
		if (timer !== undefined) time.clear(timer);
		timer = undefined;
		let next = Infinity;
		for (let intent of intents.values()) {
			if (!intent.active) continue;
			if (intent.held) {
				let allowance = allowances.get(personKey(intent.actor, intent.place));
				next = Math.min(next, (allowance?.at ?? now) + TYPING_START_INTERVAL_MS);
			} else if (intent.until > now) next = Math.min(next, intent.until);
		}
		if (next !== Infinity) {
			timer = time.set(() => {
				timer = undefined;
				settle();
			}, Math.max(1, next - now));
		}
		let snapshot = JSON.stringify(writing);
		if (snapshot === told) return;
		told = snapshot;
		seq++;
		for (let member of options.members()) {
			if (!member.data.closed) tell(member, frameOf(writing, actor(member)));
		}
	}

	function frameOf(writing: Shown[], viewer: string): Wire.Typists {
		return {
			kind: "chat:typists",
			ts: 0,
			generation,
			seq,
			typists: writing.filter(item => item.actor !== viewer).map(item => item.typist),
		};
	}

	function room(key: string): boolean {
		if (intents.has(key) || intents.size < MAX_INTENTS) return true;
		let now = time.now();
		for (let [other, intent] of intents) {
			if (!intent.active || (!intent.held && intent.until <= now)) {
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
			let key = intentKey(client, where);
			let earlier = intents.get(key);
			if (earlier && order <= earlier.seq) return;
			if (!room(key)) return;
			let now = time.now();
			if (!report.active) {
				intents.set(key, {
					client,
					actor,
					handle,
					place: where,
					seq: order,
					active: false,
					until: now,
					held: false,
				});
				return settle();
			}
			let ago = typeof report.ago === "number" && Number.isFinite(report.ago)
				? Math.min(Math.max(report.ago, 0), TYPING_REPORT_MS)
				: 0;
			let until = now - ago + TYPING_IDLE_MS + TYPING_TRANSIT_MS;
			let person = personKey(actor, where);
			let allowance = allowances.get(person);
			let intent: Intent = {
				client,
				actor,
				handle,
				place: where,
				seq: order,
				active: true,
				until,
				held: false,
			};
			if (!allowance || now - allowance.at >= TYPING_START_INTERVAL_MS) {
				allowances.set(person, { at: now, until });
			} else {
				let showing = [...intents.values()].some(other =>
					other.actor === actor && other.place === where && visible(other, now)
				);
				if (showing) intent.until = Math.min(until, allowance.until);
				else intent.held = true;
			}
			intents.set(key, intent);
			settle();
		},
		sent(client, thread) {
			let where = place(thread);
			let intent = where === undefined ? undefined : intents.get(intentKey(client, where));
			if (!intent?.active) return;
			intent.active = false;
			intent.held = false;
			settle();
		},
		depart(client) {
			let ended = false;
			for (let [key, intent] of intents) {
				if (intent.client !== client) continue;
				intents.delete(key);
				ended = true;
			}
			if (ended) settle();
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
		frame(viewer) {
			return frameOf(shown(time.now()), viewer);
		},
		close() {
			closed = true;
			if (timer !== undefined) time.clear(timer);
			timer = undefined;
			intents.clear();
			allowances.clear();
			since.clear();
			agent.clear();
		},
	};
}

/**
 * A composer's `chat:typing`. Chat's alone reaches automatic participation, exactly as it always
 * has, so who is alone with chopin is decided as before; a thread's never does.
 */
export function typed(context: Room, ws: Socket, report: TypingReport): void {
	if (report.thread === undefined) {
		initiative(context)?.typing(ws.data.client, actor(ws), report.active);
	}
	context.chat.typists?.type(ws.data.client, actor(ws), ws.data.handle, report);
}
