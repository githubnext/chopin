import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Comments on the plan.
 *
 * A thread marks a passage of prose and collects what people said about it.
 * Resolving one hides it; anyone may reopen it, which is how a resolve is
 * undone. Threads accepted or dismissed under the earlier lifecycle are still
 * stored and shown, but nothing creates them any more.
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
		| Request<Resolve.Ask>
		| Request<Reopen.Ask>
		| Typing.Input;

	export type Outgoing =
		| Sync
		| Opened
		| Said
		| Resolved
		| Reopened
		| Working
		| Start.Reply
		| Reply.Reply
		| Resolve.Reply
		| Reopen.Reply
		| Typing.Output;

	/** `accepted` and `dismissed` are only ever read back from storage. */
	export type Status = "open" | "resolved" | "accepted" | "dismissed";

	/**
	 * One thing said on a thread, by a member or by the Planner.
	 *
	 * `to` records that a member addressed the Planner. The mention a client
	 * shows is drawn from it; the text never carries one, and the server never
	 * looks for one there.
	 */
	export type Note =
		& {
			id: string;
			text: string;
			/** Unix seconds. */
			ts: number;
			to?: "planner";
		}
		& ({ author: "member"; handle: string } | { author: "planner" });

	/**
	 * What became of a note sent to the Planner, as its sender is told.
	 *
	 * `running` and `queued` mean a turn will read the thread; `off` means this
	 * server runs without a Planner, so the note is saved and nothing more.
	 */
	export type Planner = "running" | "queued" | "off";

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
		/** Who resolved it. */
		resolver?: string;
		/** When they did, Unix seconds. */
		at?: number;
		/**
		 * A Planner turn is running or queued for this thread.
		 *
		 * Derived from the live turn and its queue when a client joins, and never
		 * stored: a turn does not survive a restart, so neither does this.
		 */
		working?: boolean;
	};

	/** Every thread the plan holds, sent when a client joins. */
	export type Sync = KIND<"comment:sync"> & { threads: Thread[] };

	/**
	 * Mark a passage and say the first thing about it.
	 *
	 * The client sends what it read, not where it thinks that is: block indices
	 * and the selected text. The server finds the quote in those blocks and
	 * mints every Yjs position itself, so a client cannot place a passage
	 * anywhere the prose does not agree it belongs.
	 *
	 * The quote is the concurrency check, and a better one than a digest would
	 * be — it tests whether the sentence somebody selected is still there,
	 * which is the thing that actually matters, and a client cannot compute a
	 * canonical block digest without re-serialising the whole document anyway.
	 * If the plan moved underneath, the quote is not found and the request is
	 * refused rather than marking whatever is at that index now.
	 */
	export namespace Start {
		export type Ask = KIND<"comment:start"> & {
			/** Blocks the selection covers, first to last. */
			blocks: number[];
			/** Bounded prefix of the selected text. */
			quote: string;
			/** Where the selection began in the run's text. */
			offset: number;
			/** Characters selected. */
			length: number;
			/** The first note. */
			text: string;
			/** Address the Planner. The wire destination, never a mention, decides. */
			to?: "planner";
		};

		export type Reply =
			& KIND<"comment:start">
			& (
				| { ok: true; thread: Thread; planner?: Planner }
				| { ok: false; reason: "invalid" | "full" | "busy"; message: string }
			);
	}

	/** A new thread, announced to the room. Followed by a `plan:anchors`. */
	export type Opened = KIND<"comment:opened"> & { thread: Thread };

	/**
	 * Why a thread cannot be added to or resolved right now.
	 *
	 * `resolved` carries the outcome rather than an error message, because the
	 * thing the caller wanted to know — what happened to this thread — is
	 * already decided, and being second to ask is not a failure.
	 */
	type Blocked =
		| { ok: false; reason: "missing"; message: string }
		| { ok: false; reason: "resolved"; status: Status; resolver: string };

	export namespace Reply {
		export type Ask = KIND<"comment:reply"> & { id: string; text: string; to?: "planner" };

		export type Reply =
			& KIND<"comment:reply">
			& { id: string }
			& (
				| { ok: true; note: Note; planner?: Planner }
				| { ok: false; reason: "invalid" | "full" | "busy"; message: string }
				| Blocked
			);
	}

	/** Something said on an open thread. */
	export type Said = KIND<"comment:said"> & { id: string; note: Note };

	export namespace Resolve {
		/** Close the thread. Nothing about the document changes. */
		export type Ask = KIND<"comment:resolve"> & { id: string };

		export type Reply =
			& KIND<"comment:resolve">
			& { id: string }
			& ({ ok: true; resolver: string; at: number } | Blocked);
	}

	/**
	 * Open a resolved thread again: the undo for resolving.
	 *
	 * Only a resolved thread reopens. An accepted one already has a decision in
	 * the document, and reopening it would leave that decision describing a
	 * thread that is still being argued.
	 */
	export namespace Reopen {
		export type Ask = KIND<"comment:reopen"> & { id: string };

		export type Reply =
			& KIND<"comment:reopen">
			& { id: string }
			& (
				| { ok: true; thread: Thread }
				| { ok: false; reason: "missing" | "open" | "settled" | "full"; message: string }
			);
	}

	/** The thread is closed. Nobody may add to it until it is reopened. */
	export type Resolved = KIND<"comment:resolved"> & {
		id: string;
		status: Status;
		resolver: string;
		at: number;
		/** The marked prose as it read when this was decided. */
		quote: string;
	};

	/** A resolved thread is open again. Followed by a `plan:anchors`. */
	export type Reopened = KIND<"comment:reopened"> & { thread: Thread };

	/**
	 * Whether the Planner is working on a thread.
	 *
	 * True once a turn for it is running or queued. False when the last one
	 * ends; `reason` says why when it did not finish on its own: it was stopped,
	 * it failed, or there is no Planner to run it.
	 */
	export type Working = KIND<"comment:working"> & {
		id: string;
		working: boolean;
		reason?: "stopped" | "failed" | "off";
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
