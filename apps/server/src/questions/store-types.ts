import type { Answer, Definition, Model } from "@chopin/question";

export type Collaborator = {
	client: string;
	handle: string;
	question?: string;
	field?: "choices" | "custom";
};

export type Ended =
	| { status: "answered"; answers: Answer[]; resolver: string }
	| { status: "cancelled"; resolver: string };

export type Open = {
	id: string;
	definition: Definition;
	/** The plan node this belongs to, when it has one. */
	widget?: string;
	model: Model;
	revision: number;
	presence: Map<string, Collaborator>;
	/** Handles whose edits were accepted, in first-edit order. */
	editors: Set<string>;
	/** An advisory chat pre-selection; the draft remains human-owned. */
	suggested?: { optionId: string; messageIds: string[]; revision: number };
	/** Set while a resolution is in flight; blocks edits and rival claims. */
	claim?: "submit" | "cancel" | "option" | "edit";
	/** Resolves the promise the agent is waiting on. */
	settle?: (ended: Ended) => void;
};

export type Closed = { result: Ended; revision: number; expires: number };

export type Claim = {
	id: string;
	entry: Open;
	result: Ended;
};

export type Questions = {
	open: Map<string, Open>;
	/**
	 * Tombstones.
	 *
	 * A submit that arrives just after somebody else's would otherwise be told
	 * the questionnaire never existed, which reads as an error rather than as
	 * "they got there first".
	 */
	closed: Map<string, Closed>;
};

export type StoredOpen = {
	id: string;
	definition: Definition;
	widget?: string;
	model: number[];
	revision: number;
	suggested?: { optionId: string; messageIds: string[]; revision: number };
};
