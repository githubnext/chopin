/**
 * How far a person's message to the document's machine has got, and the browser's own outbox for
 * the ones that have not reached the server yet.
 *
 * A message is never refused because the machine is away. It is in the transcript the moment it is
 * sent and carries one quiet mark: a clock while only this browser has it (waiting for its own
 * connection), one tick once the server has it durably, two once the machine took it. Only a
 * message that can never be delivered as sent says so on itself.
 */

import type { Chat, Session } from "@chopin/protocol";
import type { ChatSendPayload } from "./references";

export type Mark = "waiting" | "sent" | "delivered";

/** What the mark says to a screen reader, and as its tooltip. */
export const MARK_LABEL: Record<Mark, string> = {
	waiting: "Waiting to send",
	sent: "Sent",
	delivered: "Delivered",
};

export const FAILED_LABEL = "Couldn't send";

/** Why the server says a message can never be delivered as it was sent. */
export const FAILURE_REASON: Record<Chat.DeliveryFailure, string> = {
	"machine-removed": "The machine it was for was removed from this document.",
	"access-lost": "You can no longer edit this document.",
	"document-unavailable": "The document it was sent from is no longer available.",
};

/**
 * Whether a refusal of a send is for a passing reason: the message is fine, and is sent again, in
 * its turn, with the same request id. Any other refusal is final, and is said on the message.
 */
export function passing(code: Session.Failure["code"]): boolean {
	return code === "planner-queue-full" || code === "temporarily-unavailable";
}

const NO_MACHINE = "No machine is connected to reply.";
const FULL = "Too many messages are waiting. Try again once they have been answered.";
const MAX_REASON = 120;

/** What a refusal of the send itself says, in plain words and no longer than a line. */
export function refusalText(code: string | undefined, message: string): string {
	if (code === "planner-not-attached") return NO_MACHINE;
	if (/queue is full/i.test(message)) return FULL;
	let detail = message.trim();
	if (!detail) return "The server turned it down.";
	detail = detail[0]!.toUpperCase() + detail.slice(1);
	let bounded = detail.length > MAX_REASON ? `${detail.slice(0, MAX_REASON - 3)}...` : detail;
	return /[.!?]$/.test(bounded) ? bounded : `${bounded}.`;
}

/** A message the browser holds and has not seen in the transcript yet, drawn as the person's own. */
export type LocalEntry = Chat.Entry & {
	echo: true;
	/** Why it was refused, once it has been. */
	failure?: string;
	/** Whether it can still be taken back; every message the machine has not taken can. */
	deletable: boolean;
};

export type Outgoing = {
	payload: ChatSendPayload;
	handle: string;
	ts: number;
	/** Put on the wire at least once, so the server may already hold it. */
	attempted?: true;
	/** The server said it has it; it is shown until its entry arrives. */
	acknowledged?: true;
	/** The id of the entry the server answered with; the request id, as a server keeps it. */
	entryId?: string;
	/** The server refused it, and why. */
	failure?: string;
	/** The server turned it down for a passing reason; it is sent again, in its turn, later. */
	full?: true;
	/** The files it carries as the server kept them, shown with it until its own entry arrives. */
	attachments?: Chat.Attachment[];
};

export type OutboxAction =
	| { kind: "add"; item: Outgoing }
	| { kind: "attempt"; id: string }
	| { kind: "acknowledge"; id: string; entryId?: string }
	| { kind: "refuse"; id: string; reason: string }
	/** The server turned it down for a passing reason, such as too many requests waiting; it is not a failure. */
	| { kind: "full"; id: string }
	/** There may be room by now: every message that was told there was none may go out again. */
	| { kind: "room" }
	| { kind: "again"; id: string }
	| { kind: "drop"; id: string }
	/** Entries or queued messages with these ids arrived: the server has them. */
	| { kind: "seen"; ids: readonly string[] }
	/** A whole transcript arrived: what is in it is no longer only ours, and what is not is gone. */
	| { kind: "history"; ids: readonly string[] };

/** Whether `ids` hold this message: under the request id, or the id the server answered with. */
function held(ids: ReadonlySet<string>, item: Outgoing): boolean {
	return ids.has(item.payload.requestId) || (!!item.entryId && ids.has(item.entryId));
}

function change(
	outbox: readonly Outgoing[],
	id: string,
	update: (item: Outgoing) => Outgoing,
): readonly Outgoing[] {
	return outbox.map(item => item.payload.requestId === id ? update(item) : item);
}

export function outboxReducer(
	outbox: readonly Outgoing[],
	action: OutboxAction,
): readonly Outgoing[] {
	switch (action.kind) {
		case "add":
			return outbox.some(item => item.payload.requestId === action.item.payload.requestId)
				? outbox
				: [...outbox, action.item];
		case "attempt":
			return change(outbox, action.id, item => ({ ...item, attempted: true }));
		case "acknowledge":
			return change(outbox, action.id, item => ({
				...item,
				acknowledged: true,
				...(action.entryId ? { entryId: action.entryId } : {}),
			}));
		case "refuse":
			return change(outbox, action.id, item => ({ ...item, failure: action.reason }));
		case "full":
			return change(outbox, action.id, item => ({ ...item, full: true }));
		case "room":
			return outbox.some(item => item.full)
				? outbox.map(({ full: _, ...item }) => item)
				: outbox;
		case "again":
			return change(outbox, action.id, ({ failure: _, ...item }) => item);
		case "drop":
			return outbox.filter(item => item.payload.requestId !== action.id);
		case "seen": {
			let ids = new Set(action.ids);
			let kept = outbox.filter(item => !held(ids, item));
			return kept.length === outbox.length ? outbox : kept;
		}
		case "history": {
			let ids = new Set(action.ids);
			return outbox.filter(item => !held(ids, item) && !item.acknowledged);
		}
	}
}

/**
 * The next message to put on the wire: the oldest the server has not been told of, so that they
 * arrive in the order they were sent. One that was refused is left where it is and does not hold
 * the others back. One the server had no room for does: those behind it would be told the same,
 * and one of them could take the place that frees up first.
 */
export function nextToSend(outbox: readonly Outgoing[]): Outgoing | undefined {
	for (let item of outbox) {
		if (item.failure || item.acknowledged) continue;
		return item.full ? undefined : item;
	}
	return undefined;
}

/**
 * What taking a message back asks of the server: the id to tell it, or nothing for a message that
 * never left the browser or that the server turned down for good, which is only dropped. Any other
 * message may be held by the server, even one whose answer never came or whose latest answer was a
 * refusal for a passing reason (an earlier attempt may have been kept, with its answer lost), so it
 * is told, whatever happened to the page since.
 */
export function retractionFor(item: Outgoing): string | undefined {
	return item.attempted && !item.failure ? item.entryId ?? item.payload.requestId : undefined;
}

/** The outbox as transcript entries, after everything the server has sent. */
export function echoes(outbox: readonly Outgoing[]): LocalEntry[] {
	return outbox.map(item => ({
		id: item.payload.requestId,
		author: { kind: "member", handle: item.handle },
		text: item.payload.text,
		ts: item.ts,
		...(item.payload.to === "planner" ? { to: "planner" as const } : {}),
		...(item.attachments?.length ? { attachments: item.attachments } : {}),
		echo: true,
		// Even one already put on the wire: the server is told to drop it if it has it.
		deletable: true,
		...(item.failure ? { deliveryState: "failed" as const, failure: item.failure } : {}),
	}));
}

type Marked = {
	echo?: true;
	failure?: string;
	deliveryState?: Chat.DeliveryState;
	deliveryFailure?: Chat.DeliveryFailure;
};

/** The mark a message carries, or `failed` when it says so on itself, or nothing. */
export function deliveryOf(message: Marked): Mark | "failed" | undefined {
	if (message.deliveryState === "failed") return "failed";
	if (message.echo) return "waiting";
	return message.deliveryState;
}

/** Why a failed message could not be sent, in plain words. */
export function failureOf(message: Marked): string {
	return message.failure
		?? (message.deliveryFailure
			? FAILURE_REASON[message.deliveryFailure]
			: "It could not be sent.");
}

/** Whether the sender may still take a message back: it has not been delivered. */
export function deletable(message: Marked & { deletable?: boolean }): boolean {
	let mark = deliveryOf(message);
	if (mark === "sent" || mark === "failed") return message.deletable !== false;
	return mark === "waiting" && message.deletable === true;
}

const KEY = "chopin:outbox";

function outboxKey(room: string, handle: string): string {
	return `${KEY}:${room}:${handle}`;
}

/**
 * Messages the person took back that the server has not been told about yet, by id. They are kept
 * as long as it has not answered, across a reload, and each is hidden from the Chat meanwhile: the
 * delete goes out by itself once there is a connection, and the message is never delivered.
 */
export type RetractionAction = { kind: "take-back"; id: string } | { kind: "settled"; id: string };

/** The refusal that says a message can no longer be taken back: the machine has it, or it is not theirs. */
const NOT_DELETABLE: Session.Failure["code"] = "message-not-deletable";

/**
 * Whether the server's answer to a delete is its last word. Only that settles it: a message the
 * machine took or that is not the person's will never be taken back. Any other refusal is for a
 * passing reason (a process stopping, storage busy), so the message stays hidden and the server is
 * asked again.
 */
export function retractionSettledBy(refusal: unknown): boolean {
	return typeof refusal === "object" && refusal !== null
		&& (refusal as { code?: unknown }).code === NOT_DELETABLE;
}

export function retractionsReducer(
	ids: readonly string[],
	action: RetractionAction,
): readonly string[] {
	if (action.kind === "take-back") return ids.includes(action.id) ? ids : [...ids, action.id];
	return ids.includes(action.id) ? ids.filter(id => id !== action.id) : ids;
}

/** The transcript without the messages that are being taken back. */
export function withoutRetracted<T extends { id: string }>(
	entries: T[],
	retractions: readonly string[],
): T[] {
	return retractions.length === 0
		? entries
		: entries.filter(entry => !retractions.includes(entry.id));
}

const RETRACTIONS_KEY = "chopin:retractions";
const MAX_RETRACTIONS = 100;

function retractionsKey(room: string, handle: string): string {
	return `${RETRACTIONS_KEY}:${room}:${handle}`;
}

/** Holds what is being taken back across a reload of this tab; storage may refuse. */
export function keepRetractions(room: string, handle: string, ids: readonly string[]): void {
	try {
		if (ids.length === 0) return sessionStorage.removeItem(retractionsKey(room, handle));
		sessionStorage.setItem(retractionsKey(room, handle), JSON.stringify(ids));
	} catch {
		// Private windows and blocked storage: it is lost with the tab, as an unsent message would be.
	}
}

/** The messages a reload left being taken back; anything malformed is left out. */
export function restoreRetractions(room: string, handle: string): readonly string[] {
	try {
		let saved: unknown = JSON.parse(sessionStorage.getItem(retractionsKey(room, handle)) ?? "[]");
		return Array.isArray(saved)
			? saved.filter((id): id is string => typeof id === "string" && id.length <= 64)
				.slice(0, MAX_RETRACTIONS)
			: [];
	} catch {
		return [];
	}
}

/** Holds the outbox across a reload of this tab; storage may refuse. */
export function keepOutbox(room: string, handle: string, outbox: readonly Outgoing[]): void {
	try {
		let pending = outbox.filter(item => !item.acknowledged && !item.failure);
		if (pending.length === 0) return sessionStorage.removeItem(outboxKey(room, handle));
		sessionStorage.setItem(
			outboxKey(room, handle),
			JSON.stringify(
				pending.map(({ payload, handle, ts, attempted, attachments }) => ({
					payload,
					handle,
					ts,
					...(attempted ? { attempted } : {}),
					...(attachments?.length ? { attachments } : {}),
				})),
			),
		);
	} catch {
		// Private windows and blocked storage: the outbox is lost with the tab, as a draft would be.
	}
}

/** The messages a reload interrupted; anything malformed is left out. */
export function restoreOutbox(room: string, handle: string): readonly Outgoing[] {
	try {
		let saved: unknown = JSON.parse(sessionStorage.getItem(outboxKey(room, handle)) ?? "[]");
		if (!Array.isArray(saved)) return [];
		return saved.flatMap((item: Partial<Outgoing>) => {
			let payload = item?.payload;
			return payload && typeof payload.requestId === "string" && typeof payload.text === "string"
					&& payload.to === "planner" && typeof item.ts === "number" && item.handle === handle
				? [{
					payload,
					handle,
					ts: item.ts,
					...(item.attempted === true ? { attempted: true as const } : {}),
					...(Array.isArray(item.attachments) && item.attachments.length
						? { attachments: item.attachments }
						: {}),
				}]
				: [];
		});
	} catch {
		return [];
	}
}
