import type { Chat } from "@chopin/protocol";
import type { CompletedWork } from "./model";

export type TranscriptState = {
	entries: Chat.Entry[];
	turn?: Chat.Turn;
	activeAnchorId?: string;
	completedWork: CompletedWork[];
};

export type TranscriptAction =
	| { kind: "history"; entries: Chat.Entry[]; turn?: Chat.Turn }
	| { kind: "message"; entry: Chat.Entry }
	| { kind: "delta"; id: string; text: string }
	| { kind: "tool"; entryId: string; activity: Chat.Activity }
	| { kind: "turn"; turn?: Chat.Turn }
	| { kind: "responded" };

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
			return withAnchor({
				entries: action.entries,
				turn: action.turn,
				activeAnchorId: sameTurn && action.entries.some(entry => entry.id === state.activeAnchorId)
					? state.activeAnchorId
					: undefined,
				completedWork,
			});
		}
		case "message": {
			let index = state.entries.findIndex(entry => entry.id === action.entry.id);
			let entries = index < 0 ? [...state.entries, action.entry] : [...state.entries];
			if (index >= 0) entries[index] = action.entry;
			return withAnchor({ ...state, entries });
		}
		case "delta":
			return withAnchor({
				...state,
				entries: state.entries.map(entry =>
					entry.id === action.id ? { ...entry, text: entry.text + action.text } : entry
				),
			});
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
		case "responded":
			return state.turn && !state.turn.responded
				? { ...state, turn: { ...state.turn, responded: true } }
				: state;
	}
}
