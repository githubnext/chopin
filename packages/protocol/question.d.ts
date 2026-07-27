import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Collaborative questions.
 *
 * A questionnaire is immutable once asked. Its answer is not: it lives in a
 * shared CRDT owned by the server, so everyone present converges on one draft
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
		| Request<Submit.Ask>
		| Request<Cancel.Ask>
		| Presence.Input;

	export type Outgoing =
		| Sync
		| Asked
		| Open.Reply
		| Edit.Reply
		| Submit.Reply
		| Cancel.Reply
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
	 * Carries the question text and the chosen labels rather than identifiers,
	 * so it still reads as prose to an agent, and still means something in a
	 * transcript after the definition it came from is gone.
	 */
	export type Answer = {
		question: string;
		choices?: string[];
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

	export namespace Presence {
		export type Input = KIND<"question:presence"> & Focus & { id: string };
		export type Output = Input & { client: string; handle: string };
	}

	export namespace Submit {
		export type Ask = KIND<"question:submit"> & {
			id: string;
			/** The draft revision being submitted, for optimistic concurrency. */
			revision: number;
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

	/** The questionnaire is closed. Nobody may answer it further. */
	export type Resolved = KIND<"question:resolved"> & {
		id: string;
		status: "answered" | "cancelled";
		resolver: string;
		answers?: Answer[];
	};
}
