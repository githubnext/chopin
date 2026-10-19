import type { Frame, Request } from "./index";
import type { ConversationPlan } from "./conversation-plan";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Collaborative questions.
 *
 * A questionnaire's definition is frozen once asked, with one exception: any
 * member with write access may append an option while it is open (`AddOption`).
 * Its answer is not frozen either: it lives in a
 * shared CRDT owned by the server, so everyone present converges on one draft
 * before somebody submits it back to the agent that is waiting on it.
 *
 * There is one answer, not one per person, because there is one decision. Any
 * member may submit it, and who did is recorded — a plan should be able to say
 * who decided a thing, not merely what was decided.
 */
export declare namespace Question {
	export type Incoming =
		| Request<Create.Ask>
		| Request<Open.Ask>
		| Request<Edit.Ask>
		| Request<Submit.Ask>
		| Request<Cancel.Ask>
		| Request<Discard.Ask>
		| Request<Reopen.Ask>
		| Request<AddOption.Ask>
		| Request<Explore.Ask>
		| Request<Explore.Stop>
		| Request<Explore.Page>
		| Request<Explore.Take>
		| Presence.Input;

	export type Outgoing =
		| Sync
		| Asked
		| Meta
		| Metas
		| Create.Reply
		| Open.Reply
		| Edit.Reply
		| Changed
		| Submit.Reply
		| Cancel.Reply
		| Discard.Reply
		| Reopen.Reply
		| AddOption.Reply
		| Explore.Reply
		| Explore.Stopped
		| Explore.Paged
		| Explore.Taken
		| OptionAdded
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
		/** Supporting context, shown only in the full decision card. */
		description?: string;
		/** Written response; options must be empty. */
		response?: "text";
		options: Option[];
		multiple: boolean;
		/** Host dialogs preserve raw text, including an explicitly submitted empty answer. */
		verbatim?: true;
	};

	export type Definition = {
		questions: Item[];
	};

	export type CardStatus = "open" | "decided" | "reopened" | "discarded" | "expired";

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

	/**
	 * Something learned while exploring a decision: a web research report, a local spike, or a
	 * person who was asked. A running finding is what the card shows as Exploring.
	 */
	export type Finding = {
		id: string;
		kind: "research" | "spike" | "ask";
		status: "running" | "ready" | "failed" | "stopped";
		/** What the exploration should find out. */
		focus?: string;
		/** The research request or investigation id, or the asked member's login. */
		ref: string;
		/** One-line result once ready. */
		title?: string;
		summary?: string;
		/** An ask's own position, given with the take. */
		stance?: "supports" | "objects";
		sources?: Array<{ title: string; url: string }>;
		sourceCount?: number;
		verdict?: string;
		branch?: string;
		/** The published child document holding the full result. */
		childId?: string;
		by: string;
		at: number;
	};

	export type CardMeta = {
		status: CardStatus;
		origin: "planner" | "conversation" | "human";
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
		/** The saved conversation decision's write-up job while it is queued, running, or failed. */
		writeup?: { status: "writing" | "failed"; job: string };
		/** Oldest first. */
		findings?: Finding[];
		/** The decision's own page, once someone has opened it. */
		childId?: string;
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

	export namespace Create {
		export type Ask = KIND<"question:create"> & {
			key: string;
			question: string;
			description?: string;
		};

		export type Reply =
			& KIND<"question:create">
			& (
				| { ok: true; id: string }
				| { ok: false; reason: "invalid" | "implementation"; message: string }
			);
	}

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
					status: Status;
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
					status: Status;
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
	export namespace AddOption {
		/**
		 * Append one option to an open question, for everyone.
		 *
		 * `key` is an idempotency token chosen by the client: repeating a request
		 * with the same key returns the option already added instead of adding
		 * another. The server mints the option's identity.
		 */
		export type Ask = KIND<"question:option"> & {
			id: string;
			question: string;
			key: string;
			label: string;
			description?: string;
		};

		export type Refusal =
			/** Malformed or out-of-bounds input. */
			| "invalid"
			/** An option with that label already exists. */
			| "duplicate"
			/** The question has reached its option limit. */
			| "full"
			/** The questionnaire is settled, or no longer exists. */
			| "resolved"
			/** A submit or cancel is already in flight. */
			| "resolving"
			/** An implementation run forbids plan and decision changes. */
			| "implementation";

		export type Reply =
			& KIND<"question:option">
			& { id: string }
			& (
				| {
					ok: true;
					option: Option;
					/** The whole definition as it now stands. */
					definition: DecisionDefinition;
					/** True when this key had already been applied. */
					repeated?: boolean;
				}
				| { ok: false; reason: Refusal; message: string }
			);
	}

	export namespace Explore {
		/**
		 * Explore an open decision: research the web, build a spike on a paired machine, or ask a
		 * member. `key` is a client-chosen UUID that becomes the finding's id, so a retry returns the
		 * finding already started.
		 */
		export type Ask = KIND<"question:explore"> & {
			id: string;
			key: string;
			action: Finding["kind"];
			/** What it should find out. */
			focus?: string;
			/** The member to ask, for `action: "ask"`. */
			login?: string;
			/** The research request the member started, for `action: "research"`. */
			ref?: string;
		};

		export type Refusal =
			| "invalid"
			/** The decision is settled, discarded or gone. */
			| "resolved"
			/** The kind cannot run here: no research, no paired machine, or no Planner owner. */
			| "unavailable"
			| "implementation";

		export type Reply =
			& KIND<"question:explore">
			& { id: string }
			& (
				| { ok: true; finding: Finding; repeated?: boolean }
				| { ok: false; reason: Refusal; message: string }
			);

		/** Stop a running finding. */
		export type Stop = KIND<"question:explore-stop"> & { id: string; finding: string };

		export type Stopped =
			& KIND<"question:explore-stop">
			& { id: string }
			& ({ ok: true } | { ok: false; message: string });

		/** The asked member's reply, which settles their `ask` finding. */
		export type Take = KIND<"question:take"> & {
			id: string;
			finding: string;
			text: string;
			stance?: "supports" | "objects";
		};

		export type Taken =
			& KIND<"question:take">
			& { id: string }
			& ({ ok: true } | { ok: false; message: string });

		/** Open the decision as its own child document, creating it the first time. */
		export type Page = KIND<"question:page"> & { id: string };

		export type Paged =
			& KIND<"question:page">
			& { id: string }
			& ({ ok: true; childId: string } | { ok: false; message: string });
	}

	/**
	 * An option was appended, after it became durable.
	 *
	 * Carries the complete definition rather than a delta, so a duplicate or
	 * late delivery is harmless.
	 */
	export type OptionAdded = KIND<"question:option-added"> & {
		id: string;
		question: string;
		option: Option;
		definition: DecisionDefinition;
		by: string;
	};

	/**
	 * How a questionnaire closed.
	 *
	 * `cancelled` takes the card out of the document: a member declined it or
	 * its asker withdrew it. `expired` is host input an earlier Chopin closed
	 * unanswered after a fixed time; questions no longer expire, so only a
	 * stored card still carries it.
	 */
	export type Status = "answered" | "cancelled" | "expired";

	/** The questionnaire is closed. Nobody may answer it further. */
	export type Resolved = KIND<"question:resolved"> & {
		id: string;
		status: Status;
		resolver: string;
		answers?: Answer[];
	};
}
