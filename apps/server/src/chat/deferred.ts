/**
 * Planner requests that were acknowledged and have not started, kept as rows.
 *
 * Chat's queue stays the working copy. A row is its durable shadow: written in the commit that
 * precedes the acknowledgement, moved in the commit of the entry that says what happened, and
 * read back when a document opens, so a request waiting behind a turn, a restart or a machine
 * that is away is never dropped.
 */
import { ulid } from "@chopin/dialect";

import type {
	DeferredTurn,
	DeferredTurnChange,
	DeferredTurnKind,
	DeferredTurnState,
	JsonValue,
	NewDeferredTurn,
} from "../storage/model";
import type { Chat as Wire } from "@chopin/protocol";

/** The row behind a queued request. */
export type Deferred = {
	row: string;
	/** What the acknowledgement named; the row's request id. */
	request: string;
	kind: DeferredTurnKind;
	/** The transcript entry of a message, which is the request itself except after a retry. */
	entry?: string;
	/** Logins that can claim a document with no owner: the sender's, and the owner's at accept. */
	claimants: string[];
};

/** What a Room needs of hosted mode to defer requests. Absent under `AUTH_MODE=local`. */
export type DeferredConfig = {
	/** How long a queue that cannot start waits before it says what it waits for. */
	noticeDelayMs: number;
	/** Builds the queue item of a comment row, in the document that holds its thread. */
	restoreComment?: (row: DeferredTurn) => Promise<unknown>;
	/** Tells whoever watches a comment thread that its request did not run. */
	threadEnded?: (row: DeferredTurn, reason: "failed") => void;
};

export type DeliveryNotice = "interrupted" | "unavailable";

type Input = {
	kind: DeferredTurnKind;
	request: string;
	handle: string;
	userId: string;
	text?: string;
	references?: Wire.Reference[];
	delivery?: JsonValue;
	focus?: { channelId: string; title: string };
	thread?: string;
	threadChannel?: string;
	planRevision?: number;
	claimant?: string;
	owner?: string;
	documentId: string;
};

/** The row for a request, accepted now. */
export function newTurn(input: Input): NewDeferredTurn {
	return {
		id: ulid(),
		documentId: input.documentId,
		requestId: input.request,
		kind: input.kind,
		handle: input.handle,
		userId: input.userId,
		text: input.kind === "comment" ? "" : input.text ?? "",
		references: (input.references ?? []) as unknown as JsonValue[],
		...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
		...(input.focus
			? { focusChannelId: input.focus.channelId, focusTitle: input.focus.title }
			: {}),
		...(input.thread ? { threadId: input.thread } : {}),
		...(input.threadChannel ? { threadChannelId: input.threadChannel } : {}),
		...(input.planRevision !== undefined ? { planRevision: input.planRevision } : {}),
		...(input.claimant ? { claimantSessionId: input.claimant } : {}),
		...(input.owner ? { ownerSessionIdAtAccept: input.owner } : {}),
		createdAt: new Date(),
	};
}

export function mark(turn: NewDeferredTurn | DeferredTurn, entry?: string): Deferred {
	return {
		row: turn.id,
		request: turn.requestId,
		kind: turn.kind,
		...(entry ? { entry } : {}),
		claimants: [turn.claimantSessionId, turn.ownerSessionIdAtAccept].filter(
			(id, index, all): id is string => !!id && all.indexOf(id) === index,
		),
	};
}

export const insert = (turn: NewDeferredTurn): DeferredTurnChange => ({ action: "insert", turn });

export const move = (
	row: string,
	from: DeferredTurnState,
	to: DeferredTurnState,
): DeferredTurnChange => ({ action: "transition", id: row, from, to, at: new Date() });

export const WAITING_NOTICE_REMOTE =
	"Waiting for this document's machine. What was sent is saved and will go through as soon as it is back.";
export const WAITING_NOTICE =
	"Waiting for someone to come back. What was sent is saved and will go through as soon as its sender, or anyone who can write to this document, writes to Chopin.";

export function interruptedNotice(row: Pick<DeferredTurn, "kind" | "handle">): string {
	return row.kind === "draft"
		? "A restart stopped the task draft, and it was not run again. Press Build to ask again."
		: row.kind === "comment"
		? `A restart stopped Chopin's reply to @${row.handle}'s comment, and it was not run again. `
			+ "Send the comment again if you still want it."
		: `A restart stopped the reply to @${row.handle}, and it was not run again. `
			+ "Ask again if you still want it.";
}

export function cancelledNotice(
	row: Pick<DeferredTurn, "kind" | "handle">,
	why: "agent" | "unavailable" | "access",
): string {
	let what = row.kind === "draft"
		? "the task draft"
		: row.kind === "comment"
		? `Chopin's reply to @${row.handle}'s comment`
		: `the request from @${row.handle}`;
	let reason = why === "agent"
		? "this document's agent was reset"
		: why === "access"
		? "its sender can no longer write to this document"
		: "the document it was sent from is gone";
	let again = row.kind === "draft"
		? " Press Build to ask again."
		: " Send it again if you still want it.";
	return `Cancelled ${what} before it ran, because ${reason}.${again}`;
}
