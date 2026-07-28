import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Comments on the plan.
 *
 * A thread marks a passage of prose and collects what people said about it.
 * Accepting one is the room deciding: the thread freezes, becomes a decision
 * recorded beside the plan and projected into it, and the agent is asked to
 * revise the prose accordingly. Dismissing one closes it without the agent.
 *
 * A thread's notes are append-only, so unlike a questionnaire's answer there is
 * no shared draft and no CRDT — nobody is co-writing one sentence, they are
 * each writing their own.
 *
 * Where a thread points is deliberately absent from these frames. A passage
 * moves whenever the plan does, and `plan:anchors` already exists to carry
 * every such relationship as one authoritative snapshot; sending it here too
 * would be a second source of truth updated on a different schedule.
 */
export declare namespace Comment {
	export type Incoming =
		| Request<Start.Ask>
		| Request<Reply.Ask>
		| Request<Accept.Ask>
		| Request<Dismiss.Ask>
		| Typing.Input;

	export type Outgoing =
		| Sync
		| Opened
		| Said
		| Resolved
		| Start.Reply
		| Reply.Reply
		| Accept.Reply
		| Dismiss.Reply
		| Typing.Output;

	export type Status = "open" | "accepted" | "dismissed";

	export type Note = {
		id: string;
		handle: string;
		text: string;
		/** Unix seconds. */
		ts: number;
	};

	export type Thread = {
		id: string;
		status: Status;
		notes: Note[];
		/**
		 * The marked prose, frozen at the moment the thread resolved.
		 *
		 * Absent while open, when the live text is the passage's and travels on
		 * `plan:anchors`. Present afterwards because a decision has to say what
		 * was actually being discussed, and the anchor keeps moving.
		 */
		quote?: string;
		/** Who accepted or dismissed it. */
		resolver?: string;
		/** When they did, Unix seconds. */
		at?: number;
	};

	/** Every thread the plan holds, sent when a client joins. */
	export type Sync = KIND<"comment:sync"> & { threads: Thread[] };

	/**
	 * Mark a passage and say the first thing about it.
	 *
	 * The client sends what it can prove rather than what it computed: block
	 * indices with the digests it read them at, and the text it selected. The
	 * server verifies the digests against its own copy and mints every Yjs
	 * position itself, so a client cannot place a passage anywhere the prose
	 * does not agree it belongs.
	 */
	export namespace Start {
		export type Ask = KIND<"comment:start"> & {
			blocks: Array<{ index: number; digest: string }>;
			/** Bounded prefix of the selected text. */
			quote: string;
			/** Where the selection began in the run's text. */
			offset: number;
			/** Characters selected. */
			length: number;
			/** The first note. */
			text: string;
		};

		export type Reply =
			& KIND<"comment:start">
			& (
				| { ok: true; thread: Thread }
				| { ok: false; reason: "invalid" | "full"; message: string }
			);
	}

	/** A new thread, announced to the room. Followed by a `plan:anchors`. */
	export type Opened = KIND<"comment:opened"> & { thread: Thread };

	export namespace Reply {
		export type Ask = KIND<"comment:reply"> & { id: string; text: string };

		export type Reply =
			& KIND<"comment:reply">
			& { id: string }
			& (
				| { ok: true; note: Note }
				| { ok: false; reason: "missing" | "resolved" | "invalid" | "full"; message: string }
			);
	}

	/** Something said on an open thread. */
	export type Said = KIND<"comment:said"> & { id: string; note: Note };

	/**
	 * A refusal that is not a failure: somebody got there first.
	 *
	 * Carries the outcome rather than an error, because the thing the caller
	 * wanted to know — what happened to this thread — is already decided.
	 */
	type Settled = {
		ok: false;
		reason: "resolved";
		status: Status;
		resolver: string;
	};

	export namespace Accept {
		/** Take the thread as the room's decision, and ask the agent to act. */
		export type Ask = KIND<"comment:accept"> & { id: string };

		export type Reply =
			& KIND<"comment:accept">
			& { id: string }
			& (
				| { ok: true; resolver: string; at: number }
				| { ok: false; reason: "missing" | "resolving" | "invalid"; message: string }
				| Settled
			);
	}

	export namespace Dismiss {
		/** Close the thread without involving the agent. */
		export type Ask = KIND<"comment:dismiss"> & { id: string };

		export type Reply =
			& KIND<"comment:dismiss">
			& { id: string }
			& (
				| { ok: true; resolver: string; at: number }
				| { ok: false; reason: "missing" | "resolving" | "invalid"; message: string }
				| Settled
			);
	}

	/** The thread is closed. Nobody may add to it. */
	export type Resolved = KIND<"comment:resolved"> & {
		id: string;
		status: Status;
		resolver: string;
		at: number;
		/** The marked prose as it read when this was decided. */
		quote: string;
	};

	/**
	 * Somebody is writing a reply.
	 *
	 * Relayed and never stored. There is no shared draft to protect here — this
	 * only stops two people writing the same reply at once, so a lost frame
	 * costs nothing and the state is allowed to lapse on its own.
	 */
	export namespace Typing {
		export type Input = KIND<"comment:typing"> & { id: string; writing: boolean };
		export type Output = Input & { client: string; handle: string };
	}
}
