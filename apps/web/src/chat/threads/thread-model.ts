import { initialTranscript, transcriptReducer } from "../transcript-state";

import type { Chat } from "@chopin/protocol";
import type { TranscriptState } from "../transcript-state";

export type ThreadViewState = {
	rootId: string;
	root?: Chat.Entry;
	forkedAt: number;
	loaded: boolean;
	transcript: TranscriptState;
	busy: boolean;
	runs?: Chat.Runs;
	usage?: Chat.ContextUsage;
	compactions: Chat.CompactionRecord[];
	compacting: boolean;
	alsoToChat: boolean;
};

export type ThreadsState = {
	summaries: Record<string, Chat.ThreadSummary>;
	openRootId?: string;
	threads: Record<string, ThreadViewState>;
	topUsage?: Chat.ContextUsage;
	topCompactions: Chat.CompactionRecord[];
	topCompacting: boolean;
};

export type ThreadsAction =
	| { kind: "reset" }
	| { kind: "open"; rootId: string; root?: Chat.Entry; nowSeconds: number }
	| { kind: "close" }
	| { kind: "set-also-to-chat"; rootId: string; value: boolean }
	| { kind: "summaries"; frame: Chat.ThreadSummaries }
	| { kind: "summary"; summary: Chat.ThreadSummary }
	| { kind: "opened"; frame: Chat.ThreadOpened }
	| { kind: "in-thread"; frame: Chat.InThread }
	| { kind: "top-context"; frame: Chat.ContextState }
	| { kind: "top-compaction"; frame: Chat.CompactionState };

export const initialThreadsState: ThreadsState = {
	summaries: {},
	threads: {},
	topCompactions: [],
	topCompacting: false,
};

function emptyThreadView(rootId: string, forkedAt: number, root?: Chat.Entry): ThreadViewState {
	return {
		rootId,
		...(root ? { root } : {}),
		forkedAt,
		loaded: false,
		transcript: initialTranscript,
		busy: false,
		compactions: [],
		compacting: false,
		alsoToChat: false,
	};
}

function appendCompaction(
	list: readonly Chat.CompactionRecord[],
	item: Chat.CompactionRecord,
): Chat.CompactionRecord[] {
	if (list.some(existing => existing.id === item.id)) return [...list];
	return [...list, item];
}

function applyInThreadFrame(
	view: ThreadViewState,
	inner: Chat.InThreadFrame,
): ThreadViewState {
	switch (inner.kind) {
		case "chat:message":
			return {
				...view,
				transcript: transcriptReducer(view.transcript, {
					kind: "message",
					entry: inner.entry,
				}),
			};
		case "chat:delta":
			return {
				...view,
				transcript: transcriptReducer(view.transcript, {
					kind: "delta",
					id: inner.id,
					text: inner.text,
				}),
			};
		case "chat:tool":
			return {
				...view,
				transcript: transcriptReducer(view.transcript, {
					kind: "tool",
					entryId: inner.entry,
					activity: inner.activity,
				}),
			};
		case "chat:state":
			return {
				...view,
				busy: inner.busy,
				runs: inner.runs,
				transcript: transcriptReducer(view.transcript, {
					kind: "turn",
					turn: inner.turn,
				}),
			};
		case "chat:context":
			return {
				...view,
				usage: inner.usage,
			};
		case "chat:compaction":
			if (inner.status === "compacting") return { ...view, compacting: true };
			if (inner.status === "idle") return { ...view, compacting: false };
			return {
				...view,
				compacting: false,
				compactions: appendCompaction(view.compactions, inner.compaction),
			};
	}
}

export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
	switch (action.kind) {
		case "reset":
			return initialThreadsState;
		case "open": {
			let existing = state.threads[action.rootId];
			let view = existing
				? { ...existing, ...(action.root ? { root: action.root } : {}) }
				: emptyThreadView(
					action.rootId,
					state.summaries[action.rootId]?.forkedAt ?? action.nowSeconds,
					action.root,
				);
			return {
				...state,
				openRootId: action.rootId,
				threads: { ...state.threads, [action.rootId]: view },
			};
		}
		case "close":
			if (state.openRootId === undefined) return state;
			return { ...state, openRootId: undefined };
		case "set-also-to-chat": {
			let existing = state.threads[action.rootId];
			if (!existing || existing.alsoToChat === action.value) return state;
			return {
				...state,
				threads: {
					...state.threads,
					[action.rootId]: { ...existing, alsoToChat: action.value },
				},
			};
		}
		case "summaries": {
			let summaries: Record<string, Chat.ThreadSummary> = {};
			for (let summary of action.frame.summaries) {
				if (summary.replyCount > 0) summaries[summary.rootId] = summary;
			}
			return {
				...state,
				summaries,
				topUsage: action.frame.usage,
				topCompactions: action.frame.compactions ?? [],
				topCompacting: !!action.frame.compacting,
			};
		}
		case "summary": {
			let summaries = { ...state.summaries };
			if (action.summary.replyCount > 0) {
				summaries[action.summary.rootId] = action.summary;
			} else {
				delete summaries[action.summary.rootId];
			}
			return { ...state, summaries };
		}
		case "opened": {
			let previous = state.threads[action.frame.rootId];
			let view: ThreadViewState = {
				rootId: action.frame.rootId,
				root: action.frame.root,
				forkedAt: action.frame.forkedAt,
				loaded: true,
				transcript: transcriptReducer(previous?.transcript ?? initialTranscript, {
					kind: "history",
					entries: action.frame.entries,
					turn: action.frame.turn,
				}),
				busy: action.frame.busy,
				runs: action.frame.runs,
				usage: action.frame.usage,
				compactions: action.frame.compactions ?? [],
				compacting: !!action.frame.compacting,
				alsoToChat: previous?.alsoToChat ?? false,
			};
			return {
				...state,
				threads: { ...state.threads, [action.frame.rootId]: view },
			};
		}
		case "in-thread": {
			let existing = state.threads[action.frame.rootId]
				?? emptyThreadView(
					action.frame.rootId,
					state.summaries[action.frame.rootId]?.forkedAt ?? Math.floor(Date.now() / 1000),
				);
			return {
				...state,
				threads: {
					...state.threads,
					[action.frame.rootId]: applyInThreadFrame(existing, action.frame.frame),
				},
			};
		}
		case "top-context":
			return { ...state, topUsage: action.frame.usage };
		case "top-compaction":
			if (action.frame.status === "compacting") return { ...state, topCompacting: true };
			if (action.frame.status === "idle") return { ...state, topCompacting: false };
			return {
				...state,
				topCompacting: false,
				topCompactions: appendCompaction(state.topCompactions, action.frame.compaction),
			};
	}
}
