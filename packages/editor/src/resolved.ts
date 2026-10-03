/**
 * The pure half of a resolved decision's margin marker.
 *
 * What the popover says, where the marker and popover sit, and which of hover
 * and pin is showing are all decidable without a browser, so they live here
 * and are tested directly. Measuring the prose and painting the marker is
 * `resolved-layer.tsx`, which can only be tested in Chromium.
 */

import { claimDecision, releaseDecision } from "./decision-pin";
import type { Question } from "@chopin/dialect";
import type { Question as ProtocolQuestion } from "@chopin/protocol";
import type { Point, Rect } from "./comment-geometry";

/**
 * The options a question's answer did not pick, in definition order.
 *
 * The plan keeps only the answer as one joined string ("A, B" for a multiple
 * choice), so this has to read the choices back out of it. Undefined whenever
 * that cannot be done exactly — a custom answer, a label that has since
 * changed, anything left over — because listing "also considered" options
 * against an answer that may have picked one of them would be a false claim.
 * Labels may themselves contain ", ", so matching is by whole label.
 */
export function unchosen(question: Question): string[] | undefined {
	let answer = question.answer;
	if (!answer || question.options.length === 0) return undefined;

	let chosen = new Set<number>();
	let rest = answer;
	while (rest.length > 0) {
		let best = -1;
		question.options.forEach((option, index) => {
			if (chosen.has(index) || !option.label) return;
			let fits = rest === option.label || rest.startsWith(`${option.label}, `);
			if (fits && (best < 0 || option.label.length > question.options[best]!.label.length)) {
				best = index;
			}
		});
		if (best < 0) return undefined;
		// A single choice never joins anything, so a remainder is not a choice.
		if (!question.multiple && rest !== question.options[best]!.label) return undefined;
		chosen.add(best);
		let label = question.options[best]!.label;
		rest = rest === label ? "" : rest.slice(label.length + 2);
	}

	return question.options.filter((_, index) => !chosen.has(index)).map(option => option.label);
}

/** An authoritative reopen/discard supersedes the stale answered document projection. */
export function resolvedKeys(
	question: Question,
	linked: string[],
	prose: string | undefined,
	meta?: ProtocolQuestion.CardMeta,
): string[] {
	if (question.answer === undefined || (meta && meta.status !== "decided")) return [];
	if (meta?.proseOrphaned) return [];
	if (meta?.hasProse) return prose ? [prose] : [];
	return linked;
}

/** Identity of one resolved decision in the document. */
export type DecisionKey = { widget: string; question: string };

export function keyOf(key: DecisionKey): string {
	return `${key.widget}/${key.question}`;
}

/**
 * What the reader is pointing at.
 *
 * `pinned` outlives the pointer; `hover` does not. There is at most one pin,
 * because a reader has one pointer and two open popovers cannot both be the
 * place they were sent.
 */
export type PointerState = { hover?: string; pinned?: string };

export type PointerAction =
	| { type: "enter"; key: string }
	| { type: "leave"; key: string }
	/** The marker: pressing it again lets go. */
	| { type: "toggle"; key: string }
	/** The prose: pressing it never lets go, so a second click is not a dismissal. */
	| { type: "pin"; key: string }
	/** Escape, the close button, or a press outside. */
	| { type: "dismiss" }
	/** The document moved: drop whatever no longer has prose to point at. */
	| { type: "prune"; live: ReadonlySet<string> };

export function point(state: PointerState, event: PointerAction): PointerState {
	switch (event.type) {
		case "prune":
			return prune(state, event.live);
		case "enter":
			return state.hover === event.key ? state : { ...state, hover: event.key };
		case "leave":
			return state.hover === event.key ? { pinned: state.pinned } : state;
		case "toggle":
			return state.pinned === event.key
				? { hover: state.hover }
				: { hover: state.hover, pinned: event.key };
		case "pin":
			return state.pinned === event.key ? state : { hover: state.hover, pinned: event.key };
		case "dismiss":
			return {};
	}
}

/** Parent and child surfaces share the pin while keeping their local pointer state. */
export function ownedPoint(
	owner: object,
	state: PointerState,
	action: PointerAction,
): PointerState {
	let next = point(state, action);
	if (action.type === "pin" || action.type === "toggle" || action.type === "dismiss") {
		if (next.pinned) claimDecision(owner, next.pinned);
		else releaseDecision(owner);
	} else if (action.type === "prune" && !next.pinned) releaseDecision(owner);
	return next;
}

/**
 * The one popover to show. A hover on a different decision borrows the surface
 * from the pin and gives it back, and only the pinned one is acted in.
 */
export function shown(state: PointerState): { key: string; pinned: boolean } | undefined {
	let key = state.hover ?? state.pinned;
	return key === undefined ? undefined : { key, pinned: key === state.pinned };
}

/** Forget a pin or hover whose decision no longer has any prose. */
export function prune(state: PointerState, live: ReadonlySet<string>): PointerState {
	let hover = state.hover !== undefined && live.has(state.hover) ? state.hover : undefined;
	let pinned = state.pinned !== undefined && live.has(state.pinned) ? state.pinned : undefined;
	return hover === state.hover && pinned === state.pinned ? state : { hover, pinned };
}

export const MARKER_SIZE = 20;
/** The same hit size as the comment button on a touch screen. */
export const MARKER_TOUCH_SIZE = 44;
const GAP = 8;
/** What a slim marker needs beside the prose: its bar and a little air. */
export const COMPACT_GUTTER = 12;

export type MarkerPlace = Point & {
	/** True when the gutter is too narrow for a disc, so the marker is a slim bar. */
	compact: boolean;
};

/**
 * Where the marker sits: in the gutter left of the first anchored block,
 * centred on its first line.
 *
 * When the gutter cannot hold the disc and its gap — a phone, or a split
 * pane — the marker becomes a slim bar the height of the first line, hugging
 * the prose instead of covering the start of it. A tap on the prose opens the
 * same popover, so nothing depends on the bar being easy to hit.
 */
export function markerPoint(
	block: Rect,
	lineHeight: number,
	host: Rect,
	size = MARKER_SIZE,
): MarkerPlace {
	let gutter = block.left - host.left;
	let top = block.top - host.top;
	if (gutter < size + GAP / 2) {
		return { top, left: Math.max(0, gutter - COMPACT_GUTTER), compact: true };
	}
	return {
		top: top + Math.max(0, (lineHeight - size) / 2),
		left: Math.min(Math.max(0, gutter - size - GAP), Math.max(0, host.width - size)),
		compact: false,
	};
}

/**
 * The popover, under the first anchored block and aligned to its start, so it
 * reads as a note on the passage rather than covering it. Flips above when the
 * document ends before it does.
 */
export function popoverBelow(block: Rect, host: Rect, width: number, height: number): Point {
	let left = Math.min(Math.max(0, block.left - host.left), Math.max(0, host.width - width));
	let below = block.bottom - host.top + GAP;
	let above = block.top - host.top - GAP - height;
	let top = below + height > host.height && above >= 0 ? above : below;
	return { top, left };
}
