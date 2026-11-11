/**
 * A person's message to the document's machine, and the browser's own outbox for the ones the
 * server has not answered yet.
 *
 * It is in the transcript the moment it is sent. While only this browser has it (it is waiting for
 * its own connection) it says Sending; once the server has it, it is an ordinary message with no
 * mark. Nothing is held for the machine: a machine that is away, or a turn that cannot take it,
 * refuses the message, and the message then says so on itself.
 */

import type { Chat, Session } from "@chopin/protocol";
import type { ChatSendPayload } from "./references";

export type Mark = "sending";

/** What the mark says to a screen reader, and as its tooltip. */
export const MARK_LABEL: Record<Mark, string> = { sending: "Sending" };

export const FAILED_LABEL = "Couldn't send";

/**
 * Whether a refusal of a send is for a passing reason: the message is fine, and is sent again, in
 * its turn, with the same request id. Any other refusal is final, and is said on the message.
 */
export function passing(code: Session.Failure["code"]): boolean {
	return code === "temporarily-unavailable";
}

const NO_MACHINE = "No machine is connected to reply.";
/**
 * What the server says of a machine that is only away: that this message was not sent, which is
 * what happened, and to send it again when the machine is back, which is what to do. It names whose
 * machine it is, so it is shown as it is.
 */
const MACHINE_AWAY = / is offline, so this message wasn't sent\. Send it again when it's back\.$/;
const MAX_REASON = 120;

/** What a refusal of the send itself says, in plain words and no longer than a line. */
export function refusalText(code: string | undefined, message: string): string {
	if (code === "planner-not-attached") {
		return MACHINE_AWAY.test(message.trim()) ? message.trim() : NO_MACHINE;
	}
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
	trouble?: true;
	/** The files it carries as the server kept them, shown with it until its own entry arrives. */
	attachments?: Chat.Attachment[];
};

export type OutboxAction =
	| { kind: "add"; item: Outgoing }
	| { kind: "attempt"; id: string }
	| { kind: "acknowledge"; id: string; entryId?: string }
	| { kind: "refuse"; id: string; reason: string }
	/** The server turned it down for a passing reason, such as storage being busy; it is not a failure. */
	| { kind: "trouble"; id: string }
	/** The trouble may have passed: every message that was turned down for it may go out again. */
	| { kind: "recovered" }
	| { kind: "again"; id: string }
	| { kind: "drop"; id: string }
	/** Entries with these ids arrived: the server has them. */
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
		case "trouble":
			return change(outbox, action.id, item => ({ ...item, trouble: true }));
		case "recovered":
			return outbox.some(item => item.trouble)
				? outbox.map(({ trouble: _, ...item }) => item)
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
 * the others back. One the server had trouble with does: those behind it would meet the same
 * trouble, and one of them could take its place.
 */
export function nextToSend(outbox: readonly Outgoing[]): Outgoing | undefined {
	for (let item of outbox) {
		if (item.failure || item.acknowledged) continue;
		return item.trouble ? undefined : item;
	}
	return undefined;
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
		...(item.failure ? { failure: item.failure } : {}),
	}));
}

type Marked = { echo?: true; failure?: string };

/** The mark a message carries, or `failed` when it says so on itself, or nothing. */
export function deliveryOf(message: Marked): Mark | "failed" | undefined {
	if (message.failure !== undefined) return "failed";
	return message.echo ? "sending" : undefined;
}

/** Why a failed message could not be sent, in plain words. */
export function failureOf(message: Marked): string {
	return message.failure ?? "It could not be sent.";
}

const KEY = "chopin:outbox";

function outboxKey(room: string, handle: string): string {
	return `${KEY}:${room}:${handle}`;
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
