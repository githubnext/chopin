import { placeOf } from "./chronology";
import { withReactions } from "./reactions";

import type { Chat } from "@chopin/protocol";
import type { CompletedWork } from "./model";

export type TranscriptState = {
	entries: Chat.Entry[];
	turn?: Chat.Turn;
	activeAnchorId?: string;
	completedWork: CompletedWork[];
	/**
	 * Entries a Retry took out, most recent last. An entry's id is never used again, so a copy of one
	 * that arrives late, or again, does not bring it back.
	 */
	removed?: string[];
};

const REMOVED_KEPT = 500;

export type TranscriptAction =
	| { kind: "history"; entries: Chat.Entry[]; turn?: Chat.Turn }
	| { kind: "message"; entry: Chat.Entry }
	/** `at` is where in the entry's text it begins, when the server said. */
	| { kind: "delta"; id: string; text: string; at?: number }
	| { kind: "tool"; entryId: string; activity: Chat.Activity }
	| { kind: "turn"; turn?: Chat.Turn }
	| { kind: "reactions"; id: string; reactions: Chat.Reaction[] }
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

/**
 * Whether a copy of an entry is older than the one shown. The server only adds to a streaming
 * entry's text and never streams an entry again once it has finished, so a streaming copy is older
 * than a finished entry, and older than a streaming one whose text runs on past it.
 */
function behind(copy: Chat.Entry, shown: Chat.Entry): boolean {
	if (!copy.streaming) return false;
	if (!shown.streaming) return true;
	return shown.text.length > copy.text.length && shown.text.startsWith(copy.text);
}

/**
 * An entry's text with a streamed piece added. A piece the server placed (`at`) that the text
 * already holds, or one that starts past its end, changes nothing: the next copy of the whole
 * entry brings what is missing.
 */
function streamed(text: string, piece: string, at: number | undefined): string {
	if (at === undefined || at === text.length) return text + piece;
	return text;
}

export function transcriptReducer(
	state: TranscriptState,
	action: TranscriptAction,
): TranscriptState {
	switch (action.kind) {
		case "history": {
			let sameTurn = state.turn?.id === action.turn?.id;
			let completedWork = sameTurn
				? state.completedWork.filter(item =>
					action.entries.some(entry => entry.id === item.anchorId)
				)
				: finish(state, action.turn?.entryOffset ?? state.entries.length, action.entries);
			let removed = state.removed?.filter(id => !action.entries.some(entry => entry.id === id));
			return withAnchor({
				entries: action.entries,
				turn: action.turn,
				...(removed?.length ? { removed } : {}),
				activeAnchorId: sameTurn && action.entries.some(entry => entry.id === state.activeAnchorId)
					? state.activeAnchorId
					: undefined,
				completedWork,
			});
		}
		case "message": {
			// A message already shown keeps its place; a new one takes its place by its time.
			if (state.removed?.includes(action.entry.id)) return state;
			let index = state.entries.findIndex(entry => entry.id === action.entry.id);
			if (index >= 0 && behind(action.entry, state.entries[index]!)) return state;
			let entries = [...state.entries];
			if (index >= 0) entries[index] = action.entry;
			else entries.splice(placeOf(entries, action.entry.ts), 0, action.entry);
			return withAnchor({ ...state, entries });
		}
		case "delta": {
			let index = state.entries.findIndex(entry => entry.id === action.id);
			let entry = state.entries[index];
			if (!entry) return state;
			let text = streamed(entry.text, action.text, action.at);
			if (text === entry.text) return state;
			let entries = [...state.entries];
			entries[index] = { ...entry, text };
			return withAnchor({ ...state, entries });
		}
		case "tool": {
			let index = state.entries.findIndex(entry => entry.id === action.entryId);
			if (index < 0) return state;
			let entries = [...state.entries];
			let entry = entries[index]!;
			let tools = entry.tools ?? [];
			let existing = tools.findIndex(item => item.id === action.activity.id);
			entries[index] = {
				...entry,
				tools: existing < 0
					? [...tools, action.activity]
					: tools.map((item, at) => at === existing ? { ...item, ...action.activity } : item),
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
		case "reactions":
			return state.entries.some(entry => entry.id === action.id)
				? { ...state, entries: withReactions(state.entries, action.id, action.reactions) }
				: state;
		case "removed": {
			// A failed attempt a Retry replaced: its entries go, and with them the work it showed.
			let gone = new Set(action.ids);
			let known = new Set(state.removed);
			let removed = action.ids.every(id => known.has(id))
				? state.removed ?? []
				: [...new Set([...known, ...action.ids])].slice(-REMOVED_KEPT);
			if (!state.entries.some(entry => gone.has(entry.id))) {
				return removed === state.removed ? state : { ...state, removed };
			}
			return {
				...state,
				removed,
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
