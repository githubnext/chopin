import type { Definition, Drafts } from "../index";
import type { AddOptionResult, Collaborator } from "./question-view";

// Archive shared state, with the current cancel API retained.
export type Unsubscribe = () => void;

export type Transport = {
	ask<K extends string>(kind: K, payload: Record<string, unknown>): Promise<never>;
	send(kind: string, payload: Record<string, unknown>): void;
	on(kind: string, handler: (event: never) => void): Unsubscribe;
};

export type QuestionnaireState = {
	definition: Definition | undefined;
	drafts: Drafts;
	collaborators: Collaborator[];
	/** True until the shared draft has arrived. */
	syncing: boolean;
	submitting: boolean;
	/** Validation or synchronisation problem, shown to the user. */
	error: string | undefined;
	change: (question: string, change: Record<string, unknown>) => void;
	addOption: (question: string, label: string) => Promise<AddOptionResult>;
	focusQuestion: (question: string | undefined) => void;
	submit: (visibleSuggestion?: { optionId: string; revision: number }) => void;
	/** Set an open decision aside. Terminal — the agent stops waiting. */
	discard: () => void;
	/** Ask the server to reopen a decided card; metadata and a new draft follow separately. */
	reopen: () => Promise<{ ok: true } | { ok: false; message: string }>;
	/** Decline to answer. Terminal — the agent stops waiting. */
	cancel: () => void;
	/** Set when submission stopped on an unanswered question. */
	focus: string | undefined;
};

export type Snapshot =
	& Omit<
		QuestionnaireState,
		"change" | "focusQuestion" | "addOption" | "submit" | "discard" | "reopen" | "cancel"
	>
	& {
		closed: boolean;
	};
