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

/** How long the resumed words stay before the banner goes. */
export const RESUMED_MS = 4000;

export type ConnectionAction = "reconnect" | "wake";

export type ConnectionView =
	| { phase: "online" }
	| {
		phase: "reconnecting";
		layer: ConnectionLayer;
		text: string;
		/** The attempt in flight, or the next, where attempts are counted. */
		attempt?: number;
		detail?: readonly string[];
		link?: { label: string; href: string };
	}
	| {
		phase: "dropped";
		layer: ConnectionLayer;
		text: string;
		/** What a person may ask for from here; absent where only the machine can act. */
		action?: ConnectionAction;
		detail?: readonly string[];
		link?: { label: string; href: string };
	}
	| {
		phase: "resumed";
		text: string;
		/** What was caught up on, in words. */
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
	/** The transcript on screen is this socket's own, sent since it opened. */
	current: boolean;
	/** The reply the transcript shows running. */
	turn: string | undefined;
	/** How many messages the transcript holds. */
	messages: number;
	/** The Planner's own connection, as the page words it, where the banner tells it. */
	planner: PlannerStatus | undefined;
};

/** What a loss that was shown leaves to say when it ends. */
export type ConnectionMemory = {
	/** What the page knew when the loss began. Set once a loss has been shown. */
	lost?: { turn: string | undefined; messages: number };
	/** A resume waiting to be said, until `expireResumed`. */
	resumed?: Extract<ConnectionView, { phase: "resumed" }>;
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
		caught: caught > 0 ? plural(caught, "new message", "new messages") : IN_SYNC,
	};
}

function plannerView(status: PlannerStatus): ConnectionView {
	let text = plannerSentence(status);
	switch (status.kind) {
		case "starting":
			return { phase: "reconnecting", layer: "planner", text };
		case "cant-start":
			return {
				phase: "dropped",
				layer: "planner",
				text,
				action: "wake",
				detail: [status.reason, status.detail],
				link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
			};
		case "disconnected":
		case "held":
		case "none":
			return { phase: "dropped", layer: "planner", text };
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
	if (facts.socket === "lost") {
		// Remembered once, as the loss is first shown: what it is later compared with. A new loss
		// ends a resume that was still being said.
		let next = memory.lost ? memory : { lost: { turn: facts.turn, messages: facts.messages } };
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
		// The socket is open again, and a shown loss ends once what it missed has arrived.
		if (!facts.synced || !facts.current) {
			return {
				memory,
				view: { phase: "reconnecting", layer: "sync", text: CATCHING_UP },
			};
		}
		let resumed = resumeOf(memory.lost, facts);
		return { memory: { resumed }, view: resumed };
	}
	if (memory.resumed) return { memory, view: memory.resumed };
	return {
		memory,
		view: facts.planner ? plannerView(facts.planner) : { phase: "online" },
	};
}

/** The resumed words are over: the banner goes, and the next layer, if any, is told. */
export function expireResumed(memory: ConnectionMemory): ConnectionMemory {
	return memory.resumed ? INITIAL_MEMORY : memory;
}

/** Which layer a banner's button asks to retry, or nothing where it has no button. */
export function retryLayer(view: ConnectionView): "socket" | "planner" | undefined {
	if (view.phase !== "dropped" || !view.action) return undefined;
	return view.action === "reconnect" ? "socket" : "planner";
}

/** What the live region last said: the phase it is on, and the last state of the Planner it told. */
export type Spoken = { key: string | undefined; planner: string | undefined };

export const NOTHING_SPOKEN: Spoken = { key: undefined, planner: undefined };

/**
 * What the polite live region says as the banner changes: the words of a phase, once, as it is
 * entered. A banner that carries on (one more attempt, the same layer dropped again) says nothing;
 * one that goes says nothing either, since the resumed words already said it was over. A Planner
 * state is remembered through the socket's own phases, so one that carried on through a loss is not
 * said again when the connection returns, and a different one is said once.
 *
 * `held` is the Planner's status being only withheld for a moment, not over: the banner falling
 * silent is then a gap, and the same state coming back after it is not said twice.
 */
export function connectionSpeech(
	previous: Spoken,
	view: ConnectionView,
	held = false,
): { spoken: Spoken; said: string } | undefined {
	if (view.phase === "online") {
		if (held || (previous.key === undefined && previous.planner === undefined)) return undefined;
		return { spoken: NOTHING_SPOKEN, said: "" };
	}
	if (view.phase === "resumed") {
		let key = "resumed:socket";
		return key === previous.key
			? undefined
			: { spoken: { ...previous, key }, said: `${view.text} ${view.caught}` };
	}
	let key = `${view.phase}:${view.layer}`;
	if (view.layer !== "planner") {
		return key === previous.key ? undefined : { spoken: { ...previous, key }, said: view.text };
	}
	return key === previous.planner
		? previous.key === key ? undefined : { spoken: { ...previous, key }, said: "" }
		: { spoken: { key, planner: key }, said: view.text };
}
