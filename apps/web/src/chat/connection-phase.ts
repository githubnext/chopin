/**
 * The one connection banner's phases, as plain decisions.
 *
 * Four exclusive phases, as assistant-ui's connection-state element names them: `online` (nothing
 * shown), `reconnecting` (attempts under way), `dropped` (a layer is down and waits for a retry
 * or for its machine) and `resumed` (it came back; said briefly, then gone). Several layers feed
 * them, in the order the page can act on them: the room's socket, the document and transcript
 * catching up on it, and the Planner's own connection. One fact is one banner: a lower layer is told
 * only while the one above it is fine, and a dropped link is the connection's to tell, never an
 * error's (see `failure.ts`).
 *
 * Kept apart from React so the rules can be tested without a page, and so that none of them can
 * be misread in a deploy: a restart the page is waiting out in silence arrives here as a socket
 * that is not lost (`useConnectionNotice`'s grace has not passed), so it shows nothing and is
 * never "resumed".
 */

import { RETRY_AFTER_FAILURES } from "@chopin/editor";

import { PLANNER_HOW_TO_FIX, plannerSentence } from "./planner-status";
import type { PlannerStatus } from "./planner-status";

export type ConnectionPhase = "online" | "dropped" | "reconnecting" | "resumed";

/** Which layer a phase speaks of. */
export type ConnectionLayer = "socket" | "sync" | "planner";

export const OFFLINE_MESSAGE =
	"You're offline. Your changes are kept and will sync when you reconnect.";
const RECONNECTING_MESSAGE = "Reconnecting. Your changes are kept.";
const CATCHING_UP = "Catching up";
const BACK_ONLINE = "Back online.";
const KEPT_GOING = "Back. The reply kept going.";
const FINISHED_AWAY = "Back. The reply finished while you were away.";
const IN_SYNC = "Your changes are synced";
const MACHINE_BACK = "The machine is back.";
const MACHINE_KEPT_GOING = "The machine is back. The reply kept going.";
const MACHINE_REPLY_ENDED = "The machine is back. The reply ended while it was away.";
const NOTHING_NEW = "Nothing new while it was away.";

/** How long the resumed words stay before the banner goes. */
export const RESUMED_MS = 4000;

/**
 * What a banner's button asks for: `reconnect` the room's socket, `wake` a machine that cannot
 * start, or `choose` another machine, which retries nothing.
 */
export type ConnectionAction = "reconnect" | "wake" | "choose";

export type ConnectionView =
	| { phase: "online" }
	| {
		phase: "reconnecting";
		layer: ConnectionLayer;
		text: string;
		/** The Planner's status, where this phase tells it. */
		plannerKind?: PlannerStatus["kind"];
		/** The attempt in flight, or the next, where attempts are counted. */
		attempt?: number;
		detail?: readonly string[];
		link?: { label: string; href: string };
	}
	| {
		phase: "dropped";
		layer: ConnectionLayer;
		text: string;
		/** The Planner's status, where this phase tells it. */
		plannerKind?: PlannerStatus["kind"];
		/** What a person may ask for from here; absent where only the machine can act. */
		action?: ConnectionAction;
		detail?: readonly string[];
		link?: { label: string; href: string };
	}
	| {
		phase: "resumed";
		/** Set where the Planner's machine came back; absent where the room's socket did. */
		layer?: "planner";
		text: string;
		/** What was caught up on, in words; empty where nothing can truthfully be said of it. */
		caught: string;
	};

/** What the page knows, as plain facts. */
export type ConnectionFacts = {
	/** The room's socket is lost and has outlasted the grace the page waits before it speaks. */
	socket: "up" | "lost";
	/** Attempts to reconnect that failed in this outage. */
	failures: number;
	/** A person's Reconnect is awaiting its attempt: the failures there were when it was pressed. */
	retrying: number | undefined;
	/** The shared document has synced on the open socket. */
	synced: boolean;
	/** Document edits still awaiting the server's acknowledgement. */
	unsaved?: boolean;
	/** The transcript on screen is this socket's own, sent since it opened. */
	current: boolean;
	/** The reply the transcript shows running. */
	turn: string | undefined;
	/** How many messages the transcript holds. */
	messages: number;
	/** The Planner's own connection, as the page words it, where the banner tells it. */
	planner: PlannerStatus | undefined;
	/**
	 * How many times a replacement of the document dropped edits the server never acknowledged.
	 * A return after one of them must not say the changes are synced.
	 */
	lostEdits?: number;
	/**
	 * The room's own word, on this socket, is that the Planner is attached. `planner` being
	 * undefined says nothing of it: the status is also withheld until its machine is known, and
	 * hidden for a person whose machine button tells it, so only this is a return.
	 */
	plannerAttached?: boolean;
	/** The reconnect attempt that opened the socket, as the banner last counted it; unknown if none. */
	reopened?: number;
	/**
	 * The viewer may choose the machine this document's Planner runs on, so a Planner that is away
	 * can be offered a different one. Chopin cannot reconnect someone else's machine.
	 */
	chooseMachine?: boolean;
};

/** What a loss that was shown leaves to say when it ends. */
export type ConnectionMemory = {
	/** What the page knew when the loss began. Set once a loss has been shown. */
	lost?: { turn: string | undefined; messages: number; edits: number };
	/**
	 * What the page knew when the Planner's drop (disconnected or held) was first shown on a
	 * transcript of this socket. It lasts through starting and failing to start, and ends with the
	 * return it is compared with, or when no machine is told.
	 */
	away?: { turn: string | undefined; messages: number };
	/** A resume waiting to be said, until `expireResumed`. */
	resumed?: Extract<ConnectionView, { phase: "resumed" }>;
	/** Lost-edit count at a socket return whose caught line can say the edits are synced. */
	resumeEdits?: number;
};

export const INITIAL_MEMORY: ConnectionMemory = {};

/**
 * The Planner's state where the banner tells it. A person with the machine button has no machine
 * to be told about on the banner: the button, bare of its dot, already says so, and `none` is
 * not something that changed. Every other state is news, for everyone.
 */
export function plannerForBanner(
	status: PlannerStatus | undefined,
	hasMachineButton: boolean,
): PlannerStatus | undefined {
	return status?.kind === "none" && hasMachineButton ? undefined : status;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function resumeOf(
	lost: NonNullable<ConnectionMemory["lost"]>,
	facts: ConnectionFacts,
): Extract<ConnectionView, { phase: "resumed" }> {
	let caught = Math.max(0, facts.messages - lost.messages);
	let text = lost.turn === undefined
		? BACK_ONLINE
		: facts.turn === lost.turn
		? KEPT_GOING
		: FINISHED_AWAY;
	return {
		phase: "resumed",
		text,
		// Edits dropped while away are the document's alert to tell: never "synced" over them.
		caught: (facts.lostEdits ?? 0) > lost.edits
			? ""
			: caught > 0
			? plural(caught, "new message", "new messages")
			: facts.unsaved
			? ""
			: IN_SYNC,
	};
}

/**
 * The machine is attached again after its drop was shown. A reply is claimed to have kept going
 * only while the very reply running at the drop is still the one running, and to have ended only
 * if one ran at the drop and is not running now; a drop with no reply running claims nothing.
 */
function plannerReturn(
	away: NonNullable<ConnectionMemory["away"]>,
	facts: ConnectionFacts,
): Extract<ConnectionView, { phase: "resumed" }> {
	let caught = Math.max(0, facts.messages - away.messages);
	return {
		phase: "resumed",
		layer: "planner",
		text: away.turn === undefined
			? MACHINE_BACK
			: facts.turn === away.turn
			? MACHINE_KEPT_GOING
			: MACHINE_REPLY_ENDED,
		caught: caught > 0 ? plural(caught, "new message", "new messages") : NOTHING_NEW,
	};
}

/** The memory with `away` set or ended, and the same object where it is as it was. */
function withAway(memory: ConnectionMemory, away: ConnectionMemory["away"]): ConnectionMemory {
	if (away === memory.away) return memory;
	let { away: _ended, ...rest } = memory;
	return away ? { ...rest, away } : rest;
}

function plannerView(status: PlannerStatus, chooseMachine = false): ConnectionView {
	let text = plannerSentence(status);
	switch (status.kind) {
		case "starting":
			return {
				phase: "reconnecting",
				layer: "planner",
				text,
				plannerKind: status.kind,
				...(status.attempt === undefined ? {} : { attempt: status.attempt }),
			};
		case "cant-start":
			return {
				phase: "dropped",
				layer: "planner",
				text,
				plannerKind: status.kind,
				action: "wake",
				detail: [status.reason, status.detail],
				link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
			};
		case "disconnected":
		case "held":
			return {
				phase: "dropped",
				layer: "planner",
				text,
				plannerKind: status.kind,
				...(chooseMachine ? { action: "choose" as const } : {}),
			};
		case "none":
			return { phase: "dropped", layer: "planner", text, plannerKind: status.kind };
	}
}

/**
 * The next memory and what to show, for what the page knows now. Call it for every change of
 * the facts; it is pure, so a repeated call with the same facts changes nothing.
 */
export function connectionStep(
	memory: ConnectionMemory,
	facts: ConnectionFacts,
): { memory: ConnectionMemory; view: ConnectionView } {
	let attached = facts.plannerAttached === true;
	// The Planner's drop is remembered once it is shown against this socket's own transcript, so a
	// return is compared with what the page knew then, never with a transcript that was not current.
	let away = memory.away;
	if (facts.planner?.kind === "none") away = undefined;
	else if (
		!away && facts.current
		&& (facts.planner?.kind === "disconnected" || facts.planner?.kind === "held")
	) {
		away = { turn: facts.turn, messages: facts.messages };
	}
	if (facts.socket === "lost") {
		// Remembered once, as the loss is first shown: what it is later compared with. A new loss
		// ends a resume that was still being said.
		let next: ConnectionMemory = memory.lost
			? withAway(memory, away)
			: {
				...(away ? { away } : {}),
				lost: { turn: facts.turn, messages: facts.messages, edits: facts.lostEdits ?? 0 },
			};
		let inFlight = facts.retrying !== undefined && facts.failures === facts.retrying;
		if (facts.failures >= RETRY_AFTER_FAILURES && !inFlight) {
			return {
				memory: next,
				view: { phase: "dropped", layer: "socket", text: OFFLINE_MESSAGE, action: "reconnect" },
			};
		}
		return {
			memory: next,
			view: {
				phase: "reconnecting",
				layer: "socket",
				text: RECONNECTING_MESSAGE,
				attempt: facts.failures + 1,
			},
		};
	}
	if (memory.lost) {
		// The socket is open again, and a shown loss ends once what it missed has arrived. The
		// attempt that opened it is kept, as `failures` starts over with the open socket.
		if (!facts.synced || !facts.current) {
			return {
				memory: withAway(memory, away),
				view: {
					phase: "reconnecting",
					layer: "sync",
					text: CATCHING_UP,
					...(facts.reopened === undefined ? {} : { attempt: facts.reopened }),
				},
			};
		}
		let resumed = resumeOf(memory.lost, facts);
		// Only a return without lost edits or new messages can later claim the edits are synced.
		let resumeEdits = (facts.lostEdits ?? 0) <= memory.lost.edits
				&& facts.messages <= memory.lost.messages
			? memory.lost.edits
			: undefined;
		// A machine that is attached again by now is part of this one return, not a second.
		let still = attached ? undefined : away;
		let next = {
			resumed,
			...(still ? { away: still } : {}),
			...(resumeEdits === undefined ? {} : { resumeEdits }),
		};
		return { memory: next, view: resumed };
	}
	if (memory.resumed) {
		let next = withAway(memory, attached ? undefined : away);
		if (memory.resumeEdits !== undefined) {
			let caught = (facts.lostEdits ?? 0) > memory.resumeEdits || facts.unsaved ? "" : IN_SYNC;
			if (caught !== memory.resumed.caught) {
				next = { ...next, resumed: { ...memory.resumed, caught } };
			}
		}
		return { memory: next, view: next.resumed! };
	}
	if (away && attached) {
		// Without this socket's own transcript there is nothing to compare, so nothing is claimed
		// yet: a restart waited out in silence reaches here before its transcript does.
		if (!facts.current) return { memory: withAway(memory, away), view: { phase: "online" } };
		let resumed = plannerReturn(away, facts);
		return { memory: { resumed }, view: resumed };
	}
	return {
		memory: withAway(memory, away),
		view: facts.planner ? plannerView(facts.planner, facts.chooseMachine) : { phase: "online" },
	};
}

/** The resumed words are over: the banner goes, and the next layer, if any, is told. */
export function expireResumed(memory: ConnectionMemory): ConnectionMemory {
	if (!memory.resumed) return memory;
	return memory.away ? { away: memory.away } : INITIAL_MEMORY;
}

/** Which layer a banner's button asks to retry, or nothing where it has no button. */
export function retryLayer(view: ConnectionView): "socket" | "planner" | undefined {
	if (view.phase !== "dropped") return undefined;
	return view.action === "reconnect" ? "socket" : view.action === "wake" ? "planner" : undefined;
}

/**
 * Whether the banner already says why a send could not go, so a message's own "Couldn't send"
 * gives way to it. Only the room's socket and sync do: a Planner that is away or absent is a
 * different fact, and a message the server turned down for good must still say so.
 */
export function silencesFailedSends(view: ConnectionView): boolean {
	return view.phase !== "online" && view.layer !== "planner";
}

/** What the live region last said: the phase it is on, and the last state of the Planner it told. */
export type Spoken = { key: string | undefined; planner: string | undefined };

export const NOTHING_SPOKEN: Spoken = { key: undefined, planner: undefined };

/**
 * What the polite live region says as the banner changes: the words of a phase, once, as it is
 * entered. A banner that carries on (one more attempt, the same layer dropped again) says nothing;
 * one that goes says nothing either, since the resumed words already said it was over. A Planner
 * state is remembered through the socket's own phases, so one that carried on through a loss is not
 * said again when the connection returns, and a different one is said once. Its kind, rather than its
 * words, distinguishes it: a machine's name or retry details can change without a new state.
 *
 * `held` is the Planner's status being only withheld for a moment, not over: clear the live region
 * for the gap, but remember what was said so the same state coming back is not said twice.
 */
export function connectionSpeech(
	previous: Spoken,
	view: ConnectionView,
	held = false,
): { spoken: Spoken; said: string } | undefined {
	if (view.phase === "online") {
		if (held) return { spoken: previous, said: "" };
		if (previous.key === undefined && previous.planner === undefined) return undefined;
		return { spoken: NOTHING_SPOKEN, said: "" };
	}
	if (view.phase === "resumed") {
		let key = `resumed:${view.layer ?? "socket"}`;
		if (key === previous.key) return undefined;
		// The machine's return ends what was told of it, so a later drop is told again.
		return {
			spoken: view.layer === "planner" ? { key, planner: undefined } : { ...previous, key },
			said: `${view.text} ${view.caught}`.trim(),
		};
	}
	let key = view.layer === "planner"
		? `${view.phase}:${view.layer}:${view.plannerKind}`
		: `${view.phase}:${view.layer}`;
	if (view.layer !== "planner") {
		return key === previous.key ? undefined : { spoken: { ...previous, key }, said: view.text };
	}
	return key === previous.planner
		? previous.key === key ? undefined : { spoken: { ...previous, key }, said: "" }
		: { spoken: { key, planner: key }, said: view.text };
}
