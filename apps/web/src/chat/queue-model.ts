/**
 * What the queue above the composer shows, from what the server says is waiting for the Planner.
 *
 * The server lists every waiting turn in the order it will start. A message kept as a row is also an
 * entry in the transcript, marked sent; it shows here while it waits and in the transcript once its
 * turn has started, never in both.
 */
import { displayName } from "@chopin/editor";

import type { Chat } from "@chopin/protocol";

/** How many waiting turns the queue shows before it folds the rest. */
export const SHOWN = 3;

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
};

/**
 * The waiting turns that have not started, in order. A message that is already in the transcript
 * as anything but sent has started, and leaves the queue before the server says so. Work nobody
 * typed is not told by such an entry: a comment's turn waits under the id of the notice that says
 * it was sent, which is in the transcript the whole time.
 */
export function queueRows(
	queue: readonly Chat.Waiting[],
	entries: readonly Pick<Chat.Entry, "id" | "deliveryState">[],
	handle: string,
): QueueRow[] {
	let started = new Set(
		entries.filter(entry => entry.deliveryState !== "sent").map(entry => entry.id),
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
		};
	});
}

/**
 * The transcript without the messages that are waiting in the queue. A hosted message is saved
 * as a transcript entry, marked sent, the moment it is accepted; the queue is where it shows until
 * its turn starts.
 */
export function withoutQueued<T extends Pick<Chat.Entry, "id" | "deliveryState">>(
	entries: T[],
	queue: readonly Pick<Chat.Waiting, "id">[],
): T[] {
	if (queue.length === 0) return entries;
	let waiting = new Set(queue.map(item => item.id));
	return entries.filter(entry => entry.deliveryState !== "sent" || !waiting.has(entry.id));
}

/** The rows shown, and how many are folded behind "more". */
export function visibleRows(
	rows: readonly QueueRow[],
	expanded: boolean,
): { shown: QueueRow[]; folded: number } {
	let shown = expanded ? [...rows] : rows.slice(0, SHOWN);
	return { shown, folded: rows.length - shown.length };
}

/** The line above the rows. */
export function queueCaption(count: number): string {
	return `${count} waiting for Chopin`;
}

/**
 * The row to put focus on once `id` has left the queue: the one that took its place, else the one
 * before it, else none, and focus goes back to the composer.
 */
export function focusAfterRemoval(rows: readonly QueueRow[], id: string): string | undefined {
	let index = rows.findIndex(row => row.id === id);
	if (index < 0) return undefined;
	return (rows[index + 1] ?? rows[index - 1])?.id;
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
