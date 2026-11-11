import type { Chat } from "./chat";

/** Whether an entry in a thread transcript counts as a conversation reply (member or Planner). */
export function isReplyEntry(entry: Pick<Chat.Entry, "author" | "deliveryState">): boolean {
	if (entry.author.kind === "system") return false;
	if (entry.deliveryState === "failed") return false;
	return true;
}

function authorKey(author: Chat.Author): string {
	if (author.kind === "member") return `member:${author.handle.toLowerCase()}`;
	return author.kind;
}

/**
 * Derive a thread's summary from its root message, fork time and reply entries.
 *
 * Unique repliers keep the order in which they first spoke in the thread. System notices
 * and failed sends do not count as replies.
 */
export function summarizeThread(
	rootId: string,
	forkedAt: number,
	entries: readonly Chat.Entry[],
): Chat.ThreadSummary {
	let participants: Chat.Author[] = [];
	let seen = new Set<string>();
	let replyCount = 0;
	let lastReplyTs = forkedAt;
	for (let entry of entries) {
		if (!isReplyEntry(entry)) continue;
		replyCount++;
		if (entry.ts > lastReplyTs) lastReplyTs = entry.ts;
		let key = authorKey(entry.author);
		if (!seen.has(key)) {
			seen.add(key);
			participants.push(
				entry.author.kind === "member"
					? { kind: "member", handle: entry.author.handle }
					: { kind: entry.author.kind },
			);
		}
	}
	return {
		rootId,
		replyCount,
		participants,
		lastReplyTs,
		forkedAt,
	};
}

/** Up to `limit` (default 3) unique participants to draw as avatars on the summary row. */
export function summaryParticipants(
	participants: readonly Chat.Author[],
	limit = 3,
): Chat.Author[] {
	return participants.slice(0, Math.max(0, limit));
}

export function replyCountLabel(count: number): string {
	return count === 1 ? "1 reply" : `${count} replies`;
}

/**
 * Relative label for the last reply timestamp (seconds since epoch), e.g.
 * "Last reply just now", "Last reply 2m ago", "Last reply 3h ago".
 */
export function formatLastReplyAge(lastReplyTs: number, nowSeconds: number): string {
	let diff = Math.max(0, Math.floor(nowSeconds - lastReplyTs));
	if (diff < 60) return "Last reply just now";
	let minutes = Math.floor(diff / 60);
	if (minutes < 60) return `Last reply ${minutes}m ago`;
	let hours = Math.floor(minutes / 60);
	if (hours < 24) return `Last reply ${hours}h ago`;
	let days = Math.floor(hours / 24);
	if (days < 14) return `Last reply ${days}d ago`;
	let weeks = Math.floor(days / 7);
	return `Last reply ${weeks}w ago`;
}

/**
 * Clock string for the fork provenance line ("Forked from Chat at 3:24 PM. Chopin remembers
 * everything up to here.").
 */
export function formatForkedClock(forkedAtSeconds: number, locale = "en-US"): string {
	let date = new Date(forkedAtSeconds * 1000);
	return new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}
