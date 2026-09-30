import type { Frame, Request } from "./index";
import type { ConversationPlan } from "./conversation-plan";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Collaborative questions.
 *
 * A questionnaire's question is fixed once asked; people may add options to it.
 * Its answer lives in a shared CRDT owned by the server, so everyone present converges on one draft
 * before somebody submits it back to the agent that is waiting on it.
 *
 * There is one answer, not one per person, because there is one decision. Any
 * member may submit it, and who did is recorded — a plan should be able to say
 * who decided a thing, not merely what was decided.
 */
export declare namespace Question {
	export type Incoming =
		| Request<Open.Ask>
		| Request<Edit.Ask>
		| Request<AddOption.Ask>
		| Request<Submit.Ask>
		| Request<Cancel.Ask>
		| Request<Discard.Ask>
		| Request<Reopen.Ask>
		| Presence.Input;

	export type Outgoing =
		| Sync
		| Asked
		| Meta
		| Metas
		| Open.Reply
		| Edit.Reply
		| AddOption.Reply
		| Changed
		| Submit.Reply
		| Cancel.Reply
		| Discard.Reply
		| Reopen.Reply
		| Presence.Output
		| Resolved;

	export type Option = {
		id: string;
		label: string;
		description: string;
	};

	export type Item = {
		id: string;
		header: string;
		question: string;
		options: Option[];
		multiple: boolean;
	};

	export type Definition = {
		questions: Item[];
	};

	export type CardStatus = "open" | "decided" | "reopened" | "discarded";

	export type OptionOrigin = {
		origin: "chat" | "planner" | "human";
		rationale?: string;
		by?: string;
		/** Exact saved option quote or a question mention from this card's thread. */
		source?: ConversationPlan.SourceRef;
	};

	export type DecisionEntry = {
		choices: string[];
		answers?: { [questionId: string]: string };
		owner: string;
		at: number;
	};

	export type CardMeta = {
		status: CardStatus;
		origin: "planner" | "conversation";
		thread?: string;
		owner?: string;
		decidedAt?: number;
		/** The member who most recently resolved this card. */
		resolver?: string;
		/** Owner first, then other people in this decision. At most eight. */
		involved: string[];
		/** Advisory choice and the card revision at which it became visible. */
		suggested?: { optionId: string; messageIds: string[]; revision: number };
		history: DecisionEntry[];
		optionOrigins: { [optionId: string]: OptionOrigin };
		/** A refine job is pending or running for this card. */
		refining: boolean;
		hasProse: boolean;
		proseOrphaned: boolean;
	};

	export type Meta = KIND<"question:meta"> & { id: string; meta: CardMeta };

	export type Metas = KIND<"question:metas"> & {
		cards: Array<{ id: string; meta: CardMeta }>;
	};

	/** One independently persisted decision card. */
	export type DecisionDefinition = {
		questions: [Item];
	};

	/**
	 * One question's answer, as it exists while being decided.
	 *
	 * `choices` and `custom` are mutually exclusive in the interface but both
	 * are carried, so switching between them does not discard what was typed.
	 */
	export type DraftAnswer = {
		mode: "choices" | "custom";
		choice: string | null;
		options: Record<string, boolean>;
		custom: string;
	};

	export type Draft = Record<string, DraftAnswer>;

	/**
	 * A decided answer.
	 *
	 * Carries readable labels for the agent and option ids for durable decisions.
	 */
	export type Answer = {
		question: string;
		choices?: string[];
		/** Ids of the chosen options, alongside their labels. */
		optionIds?: string[];
		custom?: string;
	};

	export type Point = { sid: number; time: number };

	export type Selection = { anchor: Point; focus?: Point };

	export type Focus = {
		question?: string;
		field?: "choices" | "custom";
		selection?: Selection;
	};

	export type Collaborator = Focus & {
		/** Per-connection, so one person in two tabs is two cursors. */
		client: string;
		handle: string;
	};

	/** A new questionnaire, announced to the room. */
	export type Asked = KIND<"question:asked"> & {
		id: string;
		definition: Definition;
		/** Present once the questionnaire has a node in the plan. */
		widget?: string;
	};

	/** Every open questionnaire, sent when a client joins. */
	export type Sync = KIND<"question:sync"> & {
		open: Array<{ id: string; definition: Definition; widget?: string }>;
	};

	export namespace Open {
		export type Ask = KIND<"question:open"> & { id: string };

		export type Reply =
			& KIND<"question:open">
			& (
				| {
					open: true;
					definition: Definition;
					/** json-joy model, as bytes. */
					model: number[];
					revision: number;
					presence: Collaborator[];
				}
				| { open: false }
			);
	}

	export namespace Edit {
		export type Ask = KIND<"question:edit"> & {
			id: string;
			/** One json-joy patch, as bytes. */
			patch: number[];
		};

		export type Reply =
			& KIND<"question:edit">
			& { id: string }
			& (
				| {
					open: true;
					accepted: true;
					/** False when the patch was a no-op, which is not broadcast. */
					applied: boolean;
					revision: number;
					patch?: number[];
					editor?: string;
				}
				| { open: true; accepted: false; revision: number; message: string }
				| { open: false; revision: number }
			);
	}

	export namespace AddOption {
		/** A person grows the decision. The server mints the option id. */
		export type Ask = KIND<"question:add-option"> & { id: string; label: string };

		export type Reply =
			& KIND<"question:add-option">
			& { id: string }
			& (
				| { ok: true; option: Option; revision: number }
				| {
					ok: false;
					reason: "full" | "duplicate" | "invalid" | "closed";
					message: string;
				}
			);
	}

	export type Changed = KIND<"question:changed"> & {
		id: string;
		definition: DecisionDefinition;
		revision: number;
	};

	export namespace Presence {
		export type Input = KIND<"question:presence"> & Focus & { id: string };
		export type Output = Input & { client: string; handle: string };
	}

	export namespace Submit {
		export type Ask = KIND<"question:submit"> & {
			id: string;
			/** The draft revision being submitted, for optimistic concurrency. */
			revision: number;
			/** Accept this visible advisory choice only if it is still current. */
			suggestedOptionId?: string;
		};

		export type Reply =
			& KIND<"question:submit">
			& { id: string }
			& (
				| { ok: true; answers: Answer[]; resolver: string }
				| { ok: false; reason: "stale"; current: number }
				| { ok: false; reason: "invalid"; message: string }
				| {
					ok: false;
					reason: "resolved";
					status: "answered" | "cancelled";
					resolver: string;
					answers?: Answer[];
				}
			);
	}

	export namespace Cancel {
		/** A member declines to answer. Terminal for the agent and the plan. */
		export type Ask = KIND<"question:cancel"> & { id: string };

		export type Reply =
			& KIND<"question:cancel">
			& { id: string }
			& (
				| { ok: true; resolver: string }
				| { ok: false; reason: "resolving" }
				| {
					ok: false;
					reason: "resolved";
					status: "answered" | "cancelled";
					resolver: string;
					answers?: Answer[];
				}
			);
	}

	export namespace Discard {
		/** A member sets a card aside, keeping its decision history in the document. */
		export type Ask = KIND<"question:discard"> & { id: string };

		export type Reply =
			& KIND<"question:discard">
			& { id: string }
			& (
				| { ok: true; resolver: string }
				| { ok: false; reason: "resolving" }
				| {
					ok: false;
					reason: "resolved";
					status: "discarded";
					resolver: string;
				}
			);
	}

	export namespace Reopen {
		export type Ask = KIND<"question:reopen"> & { id: string };
		export type Reply =
			& KIND<"question:reopen">
			& { id: string }
			& (
				| { ok: true }
				| { ok: false; reason: "not-decided" | "resolving" }
			);
	}

	/** The questionnaire is closed. Nobody may answer it further. */
	export type Resolved = KIND<"question:resolved"> & {
		id: string;
		status: "answered" | "cancelled";
		resolver: string;
		answers?: Answer[];
	};
}
