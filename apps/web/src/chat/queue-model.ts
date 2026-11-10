/**
 * What the queue above the composer shows, from what the server says is waiting for the Planner.
 *
 * The server lists every waiting turn in the order it will start. A message kept as a row is also an
 * entry in the transcript, marked sent; it shows here while it waits and in the transcript once its
 * turn has started, never in both.
 */
import { displayName } from "@chopin/editor";

import type { Chat } from "@chopin/protocol";

export type QueueRow = {
	id: string;
	/** Who asked: a person's name, or Chopin for work nobody typed. */
	name: string;
	/** Absent for Chopin, whose mark is drawn instead of a face. */
	handle?: string;
	/** What the turn is: the message itself, or a plain sentence about work nobody typed. */
	text: string;
	/** A message somebody typed; the rest is Chopin's own work. */
	message: boolean;
	/** The person's own message, which only they can cancel or edit. */
	mine: boolean;
	/** The server has durably saved this message and has not delivered it yet. */
	sent?: true;
};

/**
 * The waiting turns that have not started, in order. A message marked delivered or failed has
 * left the queue even if its queue frame has not arrived yet. An MCP message kept in memory has
 * no delivery mark, so the queue itself remains authoritative for it. Work nobody typed is not
 * told by such an entry: a comment's notice stays in the transcript the whole time.
 */
export function queueRows(
	queue: readonly Chat.Waiting[],
	entries: readonly Pick<Chat.Entry, "id" | "deliveryState">[],
	handle: string,
): QueueRow[] {
	let started = new Set(
		entries.filter(entry => entry.deliveryState === "delivered" || entry.deliveryState === "failed")
			.map(entry => entry.id),
	);
	let sent = new Set(
		entries.filter(entry => entry.deliveryState === "sent").map(entry => entry.id),
	);
	return queue.filter(item => item.kind !== undefined || !started.has(item.id)).map(item => {
		let message = item.kind === undefined;
		let chopin = item.handle === "chopin";
		return {
			id: item.id,
			name: chopin ? "Chopin" : displayName(item.handle),
			...(chopin ? {} : { handle: item.handle }),
			text: item.text,
			message,
			mine: message && item.handle === handle,
			...(message && sent.has(item.id) ? { sent: true as const } : {}),
		};
	});
}

/** The line above the rows. */
export function queueCaption(count: number): string {
	return `${count} waiting for Chopin`;
}

/** The next actionable row, then the previous one, or the composer when none remain. */
export function focusAfterRemoval(rows: readonly QueueRow[], id: string): string | undefined {
	let index = rows.findIndex(row => row.id === id);
	if (index < 0) return undefined;
	return rows.slice(index + 1).find(row => row.mine)?.id
		?? rows.slice(0, index).findLast(row => row.mine)?.id;
}

export type Change = "cancel" | "edit";

/**
 * What to tell a person when the server would not cancel or edit their message, in plain words.
 * `already-started` is the one refusal that says why: the Planner has begun the message's turn.
 */
export function refusalWords(change: Change, error: unknown): string {
	let { code, message } = (error ?? {}) as { code?: string; message?: unknown };
	if (code === "already-started") return "Chopin already started on it, so it can't be changed.";
	let said = typeof message === "string" ? message : "";
	if (/text is empty/i.test(said)) return "A message can't be empty.";
	if (/64 KiB/i.test(said)) return "That message is too long to send.";
	if (/author/i.test(said)) return "Only the person who wrote it can change it.";
	if (/reference/i.test(said)) {
		return "A link in that message can't be used. Remove it and try again.";
	}
	return change === "cancel"
		? "Couldn't cancel it. Try again."
		: "Couldn't save the change. Try again.";
}

/** What the edit box holds once opened, and whether saving it would change anything. */
export function editedText(original: string, draft: string): string | undefined {
	let text = draft.trim();
	return text && text !== original.trim() ? text : undefined;
}
