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
		| Reset
		| Status;

	/**
	 * A decision's place in the prose.
	 *
	 * A questionnaire asks about something and produces something, and both are
	 * passages of the plan rather than the questionnaire itself. Anchoring them
	 * is what lets a reader move between a decision and the text it concerns.
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
		/** The answer changed, so what it produced may have too. */
		| "answer_changed"
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

	/** What one question concerns, and what answering it produced. */
	export type QuestionAnchors = { subject: AnchorSet; result: AnchorSet };

	export type WidgetAnchors = {
		widget: string;
		questions: { [question: string]: QuestionAnchors };
	};

	/** Authoritative replacement snapshot of every relationship in the plan. */
	export type Anchors = KIND<"plan:anchors"> & {
		epoch: string;
		widgets: WidgetAnchors[];
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
