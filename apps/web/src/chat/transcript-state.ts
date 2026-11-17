import { placeOf, readsAfter } from "./chronology";
import { withReactions } from "./reactions";

import type { Chat } from "@chopin/protocol";
import type { CompletedWork } from "./model";

export type TranscriptState = {
	entries: Chat.Entry[];
	turn?: Chat.Turn;
	activeAnchorId?: string;
	completedWork: CompletedWork[];
	/**
	 * Entries a Retry took out, with their sequence once known. An entry's id is never used again, so
	 * a copy of one that arrives late, or again, does not bring it back. One that a later history
	 * lacks though its sequence covers it is forgotten: that history's `snapshot` keeps it out.
	 */
	removed?: Removed[];
	/** The largest `History.seq` applied: an entry of a smaller sequence that it lacked was taken out. */
	snapshot?: number;
	/**
	 * What arrived about an entry before the entry, or text past its end, kept until the entry or
	 * the text before it arrives.
	 */
	waiting?: Record<string, Waiting>;
};

type Removed = { id: string; seq?: number };

type Piece = { at: number; text: string };

type Waiting = {
	pieces?: Piece[];
	tools?: Chat.Activity[];
	reactions?: { reactions: Chat.Reaction[]; reactionsSeq?: number };
};

export type TranscriptAction =
	| { kind: "history"; entries: Chat.Entry[]; turn?: Chat.Turn; seq?: number }
	| { kind: "message"; entry: Chat.Entry }
	/** `at` is where in the entry's text it begins, when the server said. */
	| { kind: "delta"; id: string; text: string; at?: number }
	| { kind: "tool"; entryId: string; activity: Chat.Activity }
	| { kind: "turn"; turn?: Chat.Turn }
	| { kind: "reactions"; id: string; reactions: Chat.Reaction[]; reactionsSeq?: number }
	| { kind: "removed"; ids: string[] }
	| { kind: "responded" };

/**
 * How the turn in progress is shown. `current` says the transcript is this connection's own, and
 * `quiet` that a restart is being waited out in silence (`silentRestart`).
 *
 * A turn whose transcript is not current is marked disconnected, as soon as the connection that
 * carried it is gone. A restart is the exception: the page says nothing of it, so the turn goes on
 * showing as working and a restart that ends in moments leaves no trace.
 */
export function progressOf(
	state: TranscriptState,
	current: boolean,
	quiet: boolean,
): { working?: Chat.Turn; suspended?: CompletedWork; settled?: CompletedWork } {
	if (current || quiet) {
		if (!state.turn?.quiet) return { working: state.turn };
		// Nothing left of a quiet turn is for people to watch: it is drawn as the turn that ended.
		if (!state.activeAnchorId) return {};
		return {
			settled: {
				turnId: state.turn.id,
				entryOffset: state.turn.entryOffset,
				endOffset: state.entries.length,
				anchorId: state.activeAnchorId,
			},
		};
	}
	if (!state.turn || !state.activeAnchorId) return {};
	return {
		suspended: {
			turnId: state.turn.id,
			entryOffset: state.turn.entryOffset,
			endOffset: state.entries.length,
			anchorId: state.activeAnchorId,
		},
	};
}

/**
 * Whether a restart is being waited out in silence, given whether it was a moment ago. It begins
 * with a loss the server said was a restart (`restarting`) and lasts through the moment after the
 * connection opens again, until the transcript is current (`current`). It ends once the page speaks
 * of the connection (`spoken`) and does not begin again for the rest of that outage. A loss that
 * was not a restart never begins it.
 */
export function silentRestart(
	was: boolean,
	restarting: boolean,
	current: boolean,
	spoken: boolean,
): boolean {
	return !current && !spoken && (was || restarting);
}

/**
 * Whether Chat offers Stop: while a turn people can watch runs, or while a quiet one runs and a
 * message was just refused because of it, so the person can stop it to ask now.
 */
export function offersStop(busy: boolean, turn: Chat.Turn | undefined, refused: boolean): boolean {
	return busy && (!turn?.quiet || refused);
}

/** The ended turns to draw, the quiet one still running among them. */
export function shownWork(completed: CompletedWork[], settled?: CompletedWork): CompletedWork[] {
	return settled ? [...completed, settled] : completed;
}

export let initialTranscript: TranscriptState = { entries: [], completedWork: [] };

function anchor(entries: Chat.Entry[], turn: Chat.Turn): string | undefined {
	return entries.slice(turn.entryOffset).find(entry =>
		entry.author.kind === "agent"
		&& (!!entry.tools?.length || !!entry.text.trim() || !!entry.streaming)
	)?.id;
}

function withAnchor(state: TranscriptState): TranscriptState {
	if (!state.turn || state.activeAnchorId) return state;
	return { ...state, activeAnchorId: anchor(state.entries, state.turn) };
}

function finish(
	state: TranscriptState,
	endOffset: number,
	entries: Chat.Entry[] = state.entries,
): CompletedWork[] {
	let existing = state.completedWork.filter(item =>
		entries.some(entry => entry.id === item.anchorId)
	);
	if (
		!state.turn || !state.activeAnchorId
		|| !entries.some(entry => entry.id === state.activeAnchorId)
	) return existing;
	return [...existing, {
		turnId: state.turn.id,
		entryOffset: state.turn.entryOffset,
		endOffset,
		anchorId: state.activeAnchorId,
	}].slice(-50);
}

/** The longer of two texts of an entry still streaming: the server only adds to it. */
function further(shown: string, copy: string): string {
	return copy.length > shown.length ? copy : shown;
}

const settled = (status: Chat.ToolStatus) => status !== "running";

/** One tool call from two reports of it: a finished one is never running again. */
function laterActivity(shown: Chat.Activity, copy: Chat.Activity): Chat.Activity {
	if (settled(shown.status) && !settled(copy.status)) return { ...copy, ...shown };
	return { ...shown, ...copy };
}

/** The tool calls of two copies of an entry, in the order of the copy, then any it lacks. */
function laterTools(
	shown: readonly Chat.Activity[] = [],
	copy: readonly Chat.Activity[] = [],
): Chat.Activity[] {
	let known = new Map(shown.map(item => [item.id, item]));
	let tools = copy.map(item => {
		let before = known.get(item.id);
		return before ? laterActivity(before, item) : item;
	});
	let listed = new Set(copy.map(item => item.id));
	return [...tools, ...shown.filter(item => !listed.has(item.id))];
}

function longer<T>(shown: T[] | undefined, copy: T[] | undefined): T[] | undefined {
	return (copy?.length ?? 0) >= (shown?.length ?? 0) ? copy : shown;
}

/**
 * One entry from what is shown and another copy of it, whichever arrived first. The server only
 * adds to an entry: to its text while it streams, then never again; tool calls that only go from
 * running to finished; images. Its reactions are the list of the larger `reactionsSeq`, and its
 * time and sequence only grow.
 */
function merged(shown: Chat.Entry, copy: Chat.Entry): Chat.Entry {
	let finished = !shown.streaming || !copy.streaming;
	let next: Chat.Entry = copy.streaming && !shown.streaming
		? { ...copy, ...shown }
		: { ...shown, ...copy };
	next.text = !copy.streaming
		? copy.text
		: !shown.streaming
		? shown.text
		: further(shown.text, copy.text);
	if (finished) delete next.streaming;
	next.ts = Math.max(shown.ts, copy.ts);
	if (shown.seq !== undefined || copy.seq !== undefined) {
		next.seq = Math.max(shown.seq ?? 0, copy.seq ?? 0);
	}
	let tools = laterTools(shown.tools, copy.tools);
	if (tools.length) next.tools = tools;
	let reacted = (copy.reactionsSeq ?? 0) >= (shown.reactionsSeq ?? 0) ? copy : shown;
	if (reacted.reactions?.length) next.reactions = reacted.reactions;
	else delete next.reactions;
	if (reacted.reactionsSeq !== undefined) next.reactionsSeq = reacted.reactionsSeq;
	let images = longer(shown.images, copy.images);
	if (images) next.images = images;
	let refused = longer(shown.refusedImages, copy.refusedImages);
	if (refused) next.refusedImages = refused;
	return next;
}

/**
 * An entry's text with the streamed pieces that continue it, and the pieces still past its end. A
 * piece the text already holds is dropped; one that overlaps it adds only what is new. An entry
 * that has finished has all its text, so nothing is kept for it.
 */
function streamed(
	entry: Chat.Entry,
	pieces: readonly Piece[],
): { entry: Chat.Entry; rest: Piece[] } {
	let text = entry.text;
	let rest = [...pieces];
	for (let found = true; found;) {
		found = false;
		rest = rest.filter(piece => {
			if (piece.at + piece.text.length <= text.length) return false;
			if (piece.at > text.length) return true;
			text += piece.text.slice(text.length - piece.at);
			found = true;
			return false;
		});
	}
	if (!entry.streaming) rest = [];
	return { entry: text === entry.text ? entry : { ...entry, text }, rest };
}

/** An entry with what waited for it, and the pieces of text still past its end. */
function caughtUp(entry: Chat.Entry, waiting: Waiting): { entry: Chat.Entry; rest: Piece[] } {
	let next = entry;
	if (waiting.tools) next = { ...next, tools: laterTools(waiting.tools, next.tools) };
	let reacted = waiting.reactions;
	if (reacted && (reacted.reactionsSeq ?? 0) >= (next.reactionsSeq ?? 0)) {
		next = withReactions([next], next.id, reacted.reactions)[0]!;
		if (reacted.reactionsSeq !== undefined) next = { ...next, reactionsSeq: reacted.reactionsSeq };
	}
	return streamed(next, waiting.pieces ?? []);
}

/** `waiting` with an entry's replaced, or left out when nothing waits for it. */
function waitingWith(
	waiting: Record<string, Waiting> | undefined,
	id: string,
	item: Waiting | undefined,
): Pick<TranscriptState, "waiting"> {
	let next = { ...waiting };
	if (item && (item.pieces?.length || item.tools?.length || item.reactions)) next[id] = item;
	else delete next[id];
	return Object.keys(next).length ? { waiting: next } : {};
}

/** State with `entries`, and what waited for those of `ids` added to them. */
function withWaiting(
	state: TranscriptState,
	entries: Chat.Entry[],
	ids: Iterable<string>,
): TranscriptState {
	let { waiting, ...rest } = state;
	let left: Pick<TranscriptState, "waiting"> = waiting ? { waiting } : {};
	for (let id of ids) {
		let index = entries.findIndex(entry => entry.id === id);
		let item = left.waiting?.[id];
		if (index < 0 || !item) continue;
		let caught = caughtUp(entries[index]!, item);
		entries[index] = caught.entry;
		left = waitingWith(left.waiting, id, caught.rest.length ? { pieces: caught.rest } : undefined);
	}
	return { ...rest, entries, ...left };
}

/** State with something more waiting for an entry. */
function wait(
	state: TranscriptState,
	id: string,
	more: (item: Waiting) => Waiting,
): TranscriptState {
	let { waiting, ...rest } = state;
	return { ...rest, ...waitingWith(waiting, id, more(waiting?.[id] ?? {})) };
}

/** Entries with the one at `index` replaced, moved to its place if its time or sequence grew. */
function replaced(entries: Chat.Entry[], index: number, entry: Chat.Entry): Chat.Entry[] {
	let next = [...entries];
	let before = next[index - 1];
	let after = next[index + 1];
	if ((!before || !readsAfter(before, entry)) && (!after || !readsAfter(entry, after))) {
		next[index] = entry;
		return next;
	}
	next.splice(index, 1);
	next.splice(placeOf(next, entry), 0, entry);
	return next;
}

function isRemoved(state: TranscriptState, id: string): boolean {
	return !!state.removed?.some(item => item.id === id);
}

export function transcriptReducer(
	state: TranscriptState,
	action: TranscriptAction,
): TranscriptState {
	switch (action.kind) {
		case "history": {
			// A history older than one applied has nothing the newer one and the frames since lack.
			if (
				action.seq !== undefined && state.snapshot !== undefined && action.seq < state.snapshot
			) return state;
			let shown = new Map(state.entries.map(entry => [entry.id, entry]));
			let entries = action.entries.filter(entry => !isRemoved(state, entry.id)).map(entry => {
				let known = shown.get(entry.id);
				return known ? merged(known, entry) : entry;
			});
			if (action.seq !== undefined) {
				let listed = new Set(entries.map(entry => entry.id));
				// What arrived after the history was taken is newer than it, not taken out.
				for (let entry of state.entries) {
					if (listed.has(entry.id) || entry.seq === undefined || entry.seq <= action.seq) continue;
					entries.splice(placeOf(entries, entry), 0, entry);
				}
			}
			let caught = withWaiting(state, entries, entries.map(entry => entry.id));
			entries = caught.entries;
			let sameTurn = state.turn?.id === action.turn?.id;
			let completedWork = sameTurn
				? state.completedWork.filter(item => entries.some(entry => entry.id === item.anchorId))
				: finish(state, action.turn?.entryOffset ?? state.entries.length, entries);
			let snapshot = Math.max(state.snapshot ?? -Infinity, action.seq ?? -Infinity);
			// A history that lacks an entry its sequence covers was taken after it was taken out.
			let removed = state.removed?.filter(item =>
				item.seq === undefined || action.seq === undefined || item.seq > action.seq
				|| action.entries.some(entry => entry.id === item.id)
			);
			return withAnchor({
				entries,
				turn: action.turn,
				...(removed?.length ? { removed } : {}),
				...(Number.isFinite(snapshot) ? { snapshot } : {}),
				...(caught.waiting ? { waiting: caught.waiting } : {}),
				activeAnchorId: sameTurn && entries.some(entry => entry.id === state.activeAnchorId)
					? state.activeAnchorId
					: undefined,
				completedWork,
			});
		}
		case "message": {
			let entry = action.entry;
			if (isRemoved(state, entry.id)) {
				let unknown = state.removed!.some(item => item.id === entry.id && item.seq === undefined);
				if (entry.seq === undefined || !unknown) return state;
				let removed = state.removed!.map(item =>
					item.id === entry.id && item.seq === undefined ? { ...item, seq: entry.seq } : item
				);
				return { ...state, removed };
			}
			let index = state.entries.findIndex(item => item.id === entry.id);
			let entries: Chat.Entry[];
			if (index >= 0) {
				entries = replaced(state.entries, index, merged(state.entries[index]!, entry));
			} else if (
				state.snapshot !== undefined && entry.seq !== undefined && entry.seq <= state.snapshot
			) {
				// Older than the history applied, which did not have it: it had been taken out.
				return state;
			} else {
				entries = [...state.entries];
				entries.splice(placeOf(entries, entry), 0, entry);
			}
			return withAnchor(withWaiting(state, entries, [entry.id]));
		}
		case "delta": {
			if (isRemoved(state, action.id)) return state;
			let index = state.entries.findIndex(entry => entry.id === action.id);
			let entry = state.entries[index];
			if (action.at === undefined) {
				if (!entry) return state;
				let entries = [...state.entries];
				entries[index] = { ...entry, text: entry.text + action.text };
				return withAnchor({ ...state, entries });
			}
			let piece = { at: action.at, text: action.text };
			let pieces = state.waiting?.[action.id]?.pieces ?? [];
			if (pieces.some(item => item.at === piece.at && item.text === piece.text)) return state;
			if (entry && !entry.streaming) return state;
			if (!entry || piece.at > entry.text.length) {
				return wait(state, action.id, item => ({ ...item, pieces: [...pieces, piece] }));
			}
			let text = streamed(entry, [...pieces, piece]);
			let entries = [...state.entries];
			entries[index] = text.entry;
			let { waiting, ...rest } = state;
			let left = text.rest.length ? { pieces: text.rest } : undefined;
			return withAnchor({ ...rest, entries, ...waitingWith(waiting, action.id, left) });
		}
		case "tool": {
			if (isRemoved(state, action.entryId)) return state;
			let index = state.entries.findIndex(entry => entry.id === action.entryId);
			if (index < 0) {
				return wait(state, action.entryId, item => ({
					...item,
					tools: laterTools(item.tools, [action.activity]),
				}));
			}
			let entries = [...state.entries];
			let entry = entries[index]!;
			let tools = entry.tools ?? [];
			let existing = tools.findIndex(item => item.id === action.activity.id);
			entries[index] = {
				...entry,
				tools: existing < 0
					? [...tools, action.activity]
					: tools.map((item, at) => at === existing ? laterActivity(item, action.activity) : item),
			};
			return withAnchor({ ...state, entries });
		}
		case "turn": {
			let sameTurn = state.turn?.id === action.turn?.id;
			return withAnchor({
				...state,
				turn: action.turn,
				activeAnchorId: sameTurn ? state.activeAnchorId : undefined,
				// Completion and its tool projection commit together, preserving the open disclosure.
				completedWork: sameTurn
					? state.completedWork
					: finish(state, action.turn?.entryOffset ?? state.entries.length),
			});
		}
		case "reactions": {
			if (isRemoved(state, action.id)) return state;
			let reacted = { reactions: action.reactions, reactionsSeq: action.reactionsSeq };
			let entry = state.entries.find(item => item.id === action.id);
			if (!entry) {
				let before = state.waiting?.[action.id]?.reactions;
				if (before && (action.reactionsSeq ?? 0) < (before.reactionsSeq ?? 0)) return state;
				return wait(state, action.id, item => ({ ...item, reactions: reacted }));
			}
			if ((action.reactionsSeq ?? 0) < (entry.reactionsSeq ?? 0)) return state;
			let entries = withReactions(state.entries, action.id, action.reactions);
			if (action.reactionsSeq !== undefined) {
				entries = entries.map(item =>
					item.id === action.id ? { ...item, reactionsSeq: action.reactionsSeq } : item
				);
			}
			return { ...state, entries };
		}
		case "removed": {
			// A failed attempt a Retry replaced: its entries go, and with them the work it showed.
			let gone = new Set(action.ids);
			let known = new Set(state.removed?.map(item => item.id));
			let added = action.ids.filter(id => !known.has(id)).map(id => {
				let seq = state.entries.find(entry => entry.id === id)?.seq;
				return seq === undefined ? { id } : { id, seq };
			});
			let removed = added.length ? [...state.removed ?? [], ...added] : state.removed;
			let dropped = Object.keys(state.waiting ?? {}).some(id => gone.has(id));
			let waiting = dropped
				? Object.fromEntries(Object.entries(state.waiting!).filter(([id]) => !gone.has(id)))
				: state.waiting;
			let { waiting: _waiting, removed: _removed, ...rest } = state;
			let next: TranscriptState = {
				...rest,
				...(removed?.length ? { removed } : {}),
				...(waiting && Object.keys(waiting).length ? { waiting } : {}),
			};
			if (!state.entries.some(entry => gone.has(entry.id))) {
				return added.length || dropped ? next : state;
			}
			return {
				...next,
				entries: state.entries.filter(entry => !gone.has(entry.id)),
				completedWork: state.completedWork.filter(item => !gone.has(item.anchorId)),
				...(state.activeAnchorId && gone.has(state.activeAnchorId)
					? { activeAnchorId: undefined }
					: {}),
			};
		}
		case "responded":
			return state.turn && !state.turn.responded
				? { ...state, turn: { ...state.turn, responded: true } }
				: state;
	}
}
