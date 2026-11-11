import { describe, expect, test } from "bun:test";

import {
	formatForkedClock,
	formatLastReplyAge,
	replyCountLabel,
	summarizeThread,
	summaryParticipants,
} from "./threads";

import type { Chat } from "./chat";

function entry(
	id: string,
	author: Chat.Author,
	ts: number,
	extra: Partial<Chat.Entry> = {},
): Chat.Entry {
	return { id, author, text: `msg-${id}`, ts, ...extra };
}

describe("protocol/threads", () => {
	test("summarizes reply counts, unique participants in first-reply order, and last reply time", () => {
		let entries: Chat.Entry[] = [
			entry("e1", { kind: "member", handle: "Alice" }, 1010),
			entry("e2", { kind: "agent" }, 1025),
			entry("e3", { kind: "system" }, 1030),
			entry("e4", { kind: "member", handle: "alice" }, 1040),
			entry("e5", { kind: "member", handle: "bob" }, 1055, { deliveryState: "failed" }),
			entry("e6", { kind: "member", handle: "carol" }, 1060),
			entry("e7", { kind: "member", handle: "dave" }, 1075),
		];
		let summary = summarizeThread("root-1", 1000, entries);
		expect(summary).toEqual({
			rootId: "root-1",
			replyCount: 5,
			participants: [
				{ kind: "member", handle: "Alice" },
				{ kind: "agent" },
				{ kind: "member", handle: "carol" },
				{ kind: "member", handle: "dave" },
			],
			lastReplyTs: 1075,
			forkedAt: 1000,
		});
		expect(summaryParticipants(summary.participants)).toHaveLength(3);
	});

	test("formats reply count and relative last-reply age", () => {
		expect(replyCountLabel(1)).toBe("1 reply");
		expect(replyCountLabel(4)).toBe("4 replies");
		expect(formatLastReplyAge(1000, 1020)).toBe("Last reply just now");
		expect(formatLastReplyAge(1000, 1125)).toBe("Last reply 2m ago");
		expect(formatLastReplyAge(1000, 1000 + 3 * 3600)).toBe("Last reply 3h ago");
		expect(formatLastReplyAge(1000, 1000 + 5 * 86400)).toBe("Last reply 5d ago");
		expect(formatForkedClock(1760000000)).toMatch(/\d{1,2}:\d{2}/);
	});
});
