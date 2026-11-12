import { describe, expect, test } from "bun:test";

import { initialThreadsState, threadsReducer } from "./thread-model";

describe("threadsReducer", () => {
	test("tracks thread open, opened snapshot, live in-thread deltas, summaries and alsoToChat", () => {
		let root = { id: "m1", author: { kind: "member" as const, handle: "ana" }, text: "Hi", ts: 10 };
		let state = threadsReducer(initialThreadsState, {
			kind: "open",
			rootId: "m1",
			root,
			nowSeconds: 12,
		});
		expect(state.openRootId).toBe("m1");

		state = threadsReducer(state, {
			kind: "opened",
			frame: {
				kind: "chat:thread",
				ts: 12,
				rootId: "m1",
				root,
				forkedAt: 12,
				entries: [],
				busy: false,
			},
		});
		expect(state.threads.m1?.loaded).toBe(true);

		state = threadsReducer(state, { kind: "set-also-to-chat", rootId: "m1", value: true });
		expect(state.threads.m1?.alsoToChat).toBe(true);

		state = threadsReducer(state, {
			kind: "in-thread",
			frame: {
				kind: "chat:in-thread",
				ts: 13,
				rootId: "m1",
				frame: {
					kind: "chat:message",
					ts: 13,
					entry: { id: "r1", author: { kind: "agent" }, text: "Part 1", ts: 13, streaming: true },
				},
			},
		});
		state = threadsReducer(state, {
			kind: "in-thread",
			frame: {
				kind: "chat:in-thread",
				ts: 14,
				rootId: "m1",
				frame: { kind: "chat:delta", ts: 14, id: "r1", text: " and 2" },
			},
		});
		expect(state.threads.m1?.transcript.entries[0]?.text).toBe("Part 1 and 2");

		state = threadsReducer(state, {
			kind: "summary",
			summary: {
				rootId: "m1",
				replyCount: 1,
				participants: [{ kind: "agent" }],
				lastReplyTs: 14,
				forkedAt: 12,
			},
		});
		expect(state.summaries.m1?.replyCount).toBe(1);

		state = threadsReducer(state, { kind: "close" });
		expect(state.openRootId).toBeUndefined();
	});

	test("takes a retried reply's failed attempt out of the thread", () => {
		let root = { id: "m1", author: { kind: "member" as const, handle: "ana" }, text: "Hi", ts: 10 };
		let asked = {
			id: "r1",
			author: { kind: "member" as const, handle: "ana" },
			text: "Go",
			ts: 11,
			to: "planner" as const,
		};
		let partial = { id: "a1", author: { kind: "agent" as const }, text: "Half", ts: 12 };
		let notice = {
			id: "f1",
			author: { kind: "system" as const },
			text: "Failed",
			ts: 13,
			turnFailure: { kind: "error" as const, request: "r1" },
		};
		let state = threadsReducer(initialThreadsState, {
			kind: "opened",
			frame: {
				kind: "chat:thread",
				ts: 12,
				rootId: "m1",
				root,
				forkedAt: 12,
				entries: [asked, partial, notice],
				busy: false,
			},
		});
		state = threadsReducer(state, {
			kind: "in-thread",
			frame: {
				kind: "chat:in-thread",
				ts: 14,
				rootId: "m1",
				frame: { kind: "chat:removed", ts: 14, ids: ["a1", "f1"] },
			},
		});
		expect(state.threads.m1?.transcript.entries.map(entry => entry.id)).toEqual(["r1"]);
	});

	test("a reply's reactions, told in the thread, replace the ones it had", () => {
		let reply = { id: "r1", author: { kind: "agent" as const }, text: "Yes.", ts: 13 };
		let state = threadsReducer(initialThreadsState, {
			kind: "opened",
			frame: {
				kind: "chat:thread",
				ts: 12,
				rootId: "m1",
				root: { id: "m1", author: { kind: "member", handle: "ana" }, text: "Hi", ts: 10 },
				forkedAt: 12,
				entries: [reply],
				busy: false,
			},
		});
		let told = (reactions: { emoji: string; handles: string[] }[]) =>
			threadsReducer(state, {
				kind: "in-thread",
				frame: {
					kind: "chat:in-thread",
					ts: 14,
					rootId: "m1",
					frame: { kind: "chat:reactions", ts: 14, id: "r1", reactions },
				},
			});
		state = told([{ emoji: "❓", handles: ["ana"] }]);
		expect(state.threads.m1?.transcript.entries[0]?.reactions).toEqual([
			{ emoji: "❓", handles: ["ana"] },
		]);
		state = told([]);
		expect(state.threads.m1?.transcript.entries[0]?.reactions).toBeUndefined();
	});
});
