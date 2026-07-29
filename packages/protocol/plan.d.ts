import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * The collaborative document.
 *
 * A plan is a Yjs document with a headless Lexical mirror on the server. The
 * server is the sole bootstrapper and the only authority on what the document
 * contains: clients send updates and are told whether they were accepted, but
 * never seed, and never decide.
 *
 * Binary payloads travel base64. There is one socket, it carries JSON, and a
 * text frame is legible in a network inspector when something goes wrong.
 */
export declare namespace Plan {
	export type Incoming = Request<Open.Ask> | Request<Submit> | Awareness | Close;

	export type Outgoing =
		| Open.Reply
		| Ack
		| (Update & { sender?: string })
		| (Awareness & { sender?: string })
		| Anchors
		| Changes
		| Reset
		| Status;

	/**
	 * A decision's place in the prose.
	 *
	 * A decision is settled in the sidecar and lives in the plan, and those are
	 * two different places. Anchoring is what lets a reader move between them.
	 *
	 * The position is a Yjs relative position, so it survives edits above it.
	 * The digest is the block's full canonical hash, which is how a position
	 * that can no longer be resolved — after a move, or an epoch rotation — is
	 * matched back to the block it meant.
	 */
	export type Anchor = {
		/** The Yjs history `position` can be resolved in. */
		epoch: string;
		/** base64 `Y.encodeRelativePosition` of the anchored block. */
		position: string;
		/** Canonical hash of the block, for rebasing. */
		digest: string;
		/** Kept rather than guessed at when neither position nor digest resolves. */
		orphaned?: true;
	};

	/** Why a relationship is not currently trustworthy. */
	export type AnchorReason =
		/** Never anchored. */
		| "missing"
		/** The plan changed beneath it. */
		| "plan_changed"
		/** The block it named is gone, or is no longer unique. */
		| "orphaned";

	export type AnchorSet = {
		anchors: Anchor[];
		/** True when the agent has yet to review this since the last change. */
		pending: boolean;
		reason?: AnchorReason;
	};

	/**
	 * Where each of a questionnaire's decisions lives in the plan.
	 *
	 * One set per question, not two. A question used to carry what it was about
	 * and what its answer produced separately, on the theory that the two move
	 * independently — and the agent, asked to tell them apart, anchored the
	 * first block of the second and called it the first. What a reader wants is
	 * the prose the decision lives in, which is what an accepted comment has
	 * always carried.
	 */
	export type WidgetAnchors = {
		widget: string;
		questions: { [question: string]: AnchorSet };
	};

	/**
	 * A phrase of the plan, as a comment marks it.
	 *
	 * An anchor names a whole block, which is the right grain for a decision but
	 * not for a remark about one sentence in it. So a passage is the block run
	 * plus a range inside it, and the range is expressed twice for the same
	 * reason an anchor is: `start` and `end` are Yjs relative positions, so the
	 * highlight stretches as somebody types inside the phrase, and `quote` is
	 * what finds it again when they cannot be resolved — after a move, or an
	 * epoch rotation.
	 *
	 * `quote` is a bounded locator rather than the whole phrase. `length` is the
	 * real extent, so a passage longer than the bound is still recoverable:
	 * find the prefix, then run on.
	 */
	export type Passage = {
		/** The blocks it covers, first to last. */
		blocks: Anchor[];
		/** base64 `Y.encodeRelativePosition` of the range's start, in the first block. */
		start: string;
		/** base64 `Y.encodeRelativePosition` of its end, in the last. */
		end: string;
		/** Bounded prefix of the marked text. */
		quote: string;
		/** Where the quote began, so a phrase repeated in one block is not guessed at. */
		offset: number;
		/** Characters the passage covers, across the whole run. */
		length: number;
		/** Neither the positions nor the quote resolve. Kept rather than dropped. */
		drifted?: true;
	};

	/**
	 * What an accepted comment thread marks, and what accepting it produced.
	 *
	 * A thread keeps two, where a question keeps one, because these two have
	 * different authors and so different shapes. `subject` is the passage a
	 * person selected, and the server keeps it moving with the plan. `result`
	 * is the prose the agent's revision produced, and only the agent can say
	 * what that is — so it is an ordinary anchor set, reviewed and pending
	 * exactly like a question's. Neither can stand for the other: a thread's
	 * subject is usually the prose it asked to have rewritten.
	 */
	export type ThreadAnchors = {
		thread: string;
		subject: Passage;
		result: AnchorSet;
	};

	/** Authoritative replacement snapshot of every relationship in the plan. */
	export type Anchors = KIND<"plan:anchors"> & {
		epoch: string;
		widgets: WidgetAnchors[];
		threads: ThreadAnchors[];
	};

	/**
	 * A place between blocks, named by the block still beside it.
	 *
	 * What the agent took out has no anchor of its own: a relative position
	 * needs a live collaborative type and the departed block's is gone. So a
	 * gap is described by a survivor and the side the content was on. That the
	 * plan can never be emptied is what guarantees a survivor exists.
	 */
	export type Gap = {
		at: Anchor;
		side: "before" | "after";
	};

	/** Enough of a block to recognise it in a list. */
	export type Excerpt = {
		/** The MDAST node type, or the component name for a dialect block. */
		type: string;
		/** Bounded flattened text. */
		preview: string;
	};

	/**
	 * One thing the agent did to the plan, as a reader can find it.
	 *
	 * A move is one change rather than a disappearance and an arrival, because
	 * a reader who is shown those separately has to work out for themselves
	 * that they are the same block. A rewrite is `added` alone: something is
	 * still there to look at, and marking a gap as well would put a tombstone
	 * on the most common edit the agent makes.
	 */
	export type Change =
		| ({ kind: "added"; at: Anchor } & Excerpt)
		| ({ kind: "moved"; at: Anchor; from: Gap } & Excerpt)
		| { kind: "removed"; at: Gap; blocks: Excerpt[] };

	/**
	 * What the agent just did to the plan.
	 *
	 * Ephemeral, and deliberately not replayed on open: somebody arriving
	 * afterwards is reading the plan, not watching it being written.
	 */
	export type Changes = KIND<"plan:changes"> & {
		epoch: string;
		changes: Change[];
	};

	/**
	 * Bounds the server enforces, sent on open.
	 *
	 * Clients hold the same numbers so they can refuse early with the same
	 * answer, rather than guessing and discovering the limit by rejection.
	 */
	export type Limits = {
		source: number;
		update: number;
		depth: number;
	};

	/**
	 * Join the document.
	 *
	 * A client that already holds state for `epoch` sends its state vector and
	 * receives only the difference. Any other case — no epoch, or one the
	 * server has since rotated — gets the whole document under the current one.
	 */
	export namespace Open {
		export type Ask = KIND<"plan:open"> & {
			epoch?: string;
			/** base64 `Y.encodeStateVector` */
			vector?: string;
		};

		export type Reply = KIND<"plan:open"> & {
			/** Identifies one Yjs history. Updates from another are rejected. */
			epoch: string;
			/** Monotonic within an epoch. Useful for ordering and diagnostics. */
			seq: number;
			/** base64 `Y.encodeStateAsUpdate`, diffed against `vector` when given. */
			update: string;
			/** base64 awareness snapshot of everyone already connected. */
			awareness?: string;
			/** Document revision, for the agent's optimistic concurrency. */
			revision: number;
			/** Which prose each decision relates to, as an authoritative snapshot. */
			anchors: WidgetAnchors[];
			/** Which prose each comment thread marks, on the same terms. */
			threads: ThreadAnchors[];
			limits: Limits;
		};
	}

	/**
	 * Submit a Yjs update.
	 *
	 * `id` makes a retry after a lost acknowledgement idempotent, so a client
	 * that reconnects mid-flight can resend without risking a duplicate edit.
	 */
	export type Submit = KIND<"plan:update"> & {
		epoch: string;
		id: string;
		/** base64 Yjs update */
		update: string;
	};

	/**
	 * Confirms one submitted update.
	 *
	 * Separate from {@link Update} so the bytes are not echoed back to the
	 * client that already applied them locally.
	 */
	export type Ack = KIND<"plan:ack"> & {
		epoch: string;
		id: string;
		seq: number;
	};

	/** A committed update, relayed to everyone else. */
	export type Update = KIND<"plan:update"> & {
		epoch: string;
		/** base64 Yjs update */
		update: string;
		seq: number;
	};

	/** Ephemeral presence: cursors, selections, focus. Never persisted. */
	export type Awareness = KIND<"plan:awareness"> & {
		epoch: string;
		/** base64 y-protocols awareness update */
		update: string;
	};

	/** Leave the document. Presence is dropped; the room stays open. */
	export type Close = KIND<"plan:close">;

	/**
	 * The epoch was replaced and local state is no longer valid.
	 *
	 * Clients discard their document and re-open. Undo history and cursors are
	 * intentionally lost — this is the boundary where continuity ends.
	 */
	export type Reset = KIND<"plan:reset"> & {
		epoch: string;
		reason:
			/** Content was replaced wholesale. */
			| "replaced"
			/** A member cleared the plan. */
			| "cleared"
			/** History outgrew its budget and was compacted. */
			| "compacted"
			/** An update did not validate and the room was rebuilt. */
			| "rebuilt";
	};

	/** Durability, surfaced in the editor chrome. */
	export type Status = KIND<"plan:status"> & {
		state:
			/** Accepted in memory, not yet written to disk. */
			| "saving"
			/** The latest source is on disk. */
			| "saved"
			/** Writing is failing; editing continues. */
			| "error";
		revision: number;
		message?: string;
	};
}
