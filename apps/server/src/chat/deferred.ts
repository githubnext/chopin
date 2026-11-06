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
	DeferredCancelReason,
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

/**
 * Whether a person's Planner requests are kept as rows. Hosted mode always keeps them. `AUTH_MODE=local`
 * is never handed over and keeps its queue in memory, except where the Planner runs on a machine
 * (`HARNESS=remote`): that machine can be away, and a message to it is saved and waits for it as
 * anywhere else.
 */
export function keepsRequests(config: { auth: { local?: unknown }; harness: string }): boolean {
	return !config.auth.local || config.harness === "remote";
}

/** What a Room needs to defer requests. Absent under `AUTH_MODE=local` unless a machine runs the Planner. */
export type DeferredConfig = {
	/** Builds the queue item of a comment row, in the document that holds its thread. */
	restoreComment?: (row: DeferredTurn) => Promise<unknown>;
	/** Tells whoever watches a comment thread that its request did not run. */
	threadEnded?: (row: DeferredTurn, reason: "failed") => void;
};

/**
 * What the server hands a document's Chat to keep a person's Planner requests as rows: whether the
 * machine is there, and the rest a row needs when it starts. Empty where requests are not kept,
 * so the same call is made for every configuration and the configuration decides.
 */
export function deferralWiring(
	config: { auth: { local?: unknown }; harness: string },
	hooks: {
		/** Whether the document's machine is attached; absent where nothing can be away. */
		plannerReady?: () => Promise<boolean>;
	} & Pick<DeferredConfig, "restoreComment" | "threadEnded">,
): { plannerReady?: () => Promise<boolean>; deferred?: DeferredConfig } {
	if (!keepsRequests(config)) return {};
	return {
		...(hooks.plannerReady ? { plannerReady: hooks.plannerReady } : {}),
		deferred: {
			...(hooks.restoreComment ? { restoreComment: hooks.restoreComment } : {}),
			...(hooks.threadEnded ? { threadEnded: hooks.threadEnded } : {}),
		},
	};
}

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
	reason?: DeferredCancelReason,
): DeferredTurnChange => ({
	action: "transition",
	id: row,
	from,
	to,
	at: new Date(),
	...(reason ? { reason } : {}),
});

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
