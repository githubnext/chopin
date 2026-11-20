import { describe, expect, test } from "bun:test";

import { announcement, receiveTypists, threadsWithTypers, typersIn, typingWords } from "./typists";

import type { Chat as Wire } from "@chopin/protocol";

let member = (handle: string, since: number, thread?: string): Wire.Typist => ({
	author: { kind: "member", handle },
	since,
	...(thread ? { thread } : {}),
});
let planner = (since: number, thread?: string): Wire.Typist => ({
	author: { kind: "agent" },
	since,
	...(thread ? { thread } : {}),
});
let frame = (seq: number, typists: Wire.Typist[], generation = 1): Wire.Typists => ({
	kind: "chat:typists",
	ts: 0,
	generation,
	seq,
	typists,
});

describe("who is shown writing", () => {
	test("the line names one or two people and says several for three or more", () => {
		let state = receiveTypists(undefined, frame(1, [member("ana", 1)]));
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("@ana is typing…");
		state = receiveTypists(state, frame(2, [member("ana", 1), member("bo", 2)]));
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("@ana and @bo are typing…");
		state = receiveTypists(state, frame(3, [member("ana", 1), member("bo", 2), member("cy", 3)]));
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("Several people are typing…");
		expect(typingWords([])).toBe("");
	});

	test("the viewer never sees themself", () => {
		let state = receiveTypists(undefined, frame(1, [member("me", 1), member("ana", 2)]));
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("@ana is typing…");
		state = receiveTypists(state, frame(2, [member("me", 1)]));
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("");
	});

	test("people are named in the order they began, whatever order they arrive in, each once", () => {
		let state = receiveTypists(
			undefined,
			frame(1, [member("bo", 20), member("ana", 10), member("bo", 30), member("cy", 10)]),
		);
		expect(typersIn(state, { viewer: "me" })).toEqual([
			{ kind: "member", handle: "ana" },
			{ kind: "member", handle: "cy" },
			{ kind: "member", handle: "bo" },
		]);
	});

	test("the words are a function of who is writing in the place, not of how often they are told", () => {
		let one = receiveTypists(undefined, frame(1, [member("ana", 1), member("bo", 2)]));
		let again = receiveTypists(one, frame(2, [member("bo", 2), member("ana", 1)]));
		expect(typingWords(typersIn(again, { viewer: "me" })))
			.toBe(typingWords(typersIn(one, { viewer: "me" })));
	});

	test("a thread's writing shows only in that thread, and Chat's only in Chat", () => {
		let state = receiveTypists(
			undefined,
			frame(1, [member("ana", 1, "root-1"), member("bo", 2), member("cy", 3, "root-2")]),
		);
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("@bo is typing…");
		expect(typingWords(typersIn(state, { viewer: "me", thread: "root-1" })))
			.toBe("@ana is typing…");
		let threads = threadsWithTypers(state, "me");
		expect([...threads.keys()]).toEqual(["root-1", "root-2"]);
		expect(typingWords(threads.get("root-2")!, "replying")).toBe("@cy is replying…");
	});

	test("a thread only the viewer writes in has no row", () => {
		let state = receiveTypists(undefined, frame(1, [member("me", 1, "root-1")]));
		expect(threadsWithTypers(state, "me").size).toBe(0);
	});

	test("chopin is named as itself, and left out where its working row already shows it", () => {
		let state = receiveTypists(undefined, frame(1, [planner(1), member("ana", 2)]));
		expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("chopin and @ana are typing…");
		expect(typingWords(typersIn(state, { viewer: "me", planner: false })))
			.toBe("@ana is typing…");
		state = receiveTypists(state, frame(2, [planner(1, "root-1")]));
		expect(typingWords(threadsWithTypers(state, "me").get("root-1")!, "replying"))
			.toBe("chopin is replying…");
	});

	test("an older snapshot, repeated or overtaken, changes nothing; the newest wins in any order", () => {
		let frames = [
			frame(1, [member("ana", 1)]),
			frame(2, []),
			frame(3, [member("ana", 3)]),
		];
		for (let order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1, 1, 0, 2]]) {
			let state = order.reduce<ReturnType<typeof receiveTypists> | undefined>(
				(current, index) => receiveTypists(current, frames[index]!),
				undefined,
			);
			expect(typingWords(typersIn(state, { viewer: "me" }))).toBe("@ana is typing…");
			expect(state!.seq).toBe(3);
		}
		let newest = receiveTypists(undefined, frames[2]!);
		expect(receiveTypists(newest, frames[2]!)).toBe(newest);
	});

	test("a room opened again outranks every snapshot of the one before, whatever their numbers", () => {
		let reopened = receiveTypists(undefined, frame(0, [], 2));
		let late = receiveTypists(reopened, frame(9, [member("ana", 1)], 1));
		expect(late).toBe(reopened);
		let next = receiveTypists(late, frame(1, [member("bo", 1)], 2));
		expect(typingWords(typersIn(next, { viewer: "me" }))).toBe("@bo is typing…");
	});

	test("after a reconnect the first snapshot is taken whatever its number", () => {
		let before = receiveTypists(undefined, frame(1_000, [member("ana", 1)]));
		expect(typersIn(before, { viewer: "me" })).toHaveLength(1);
		let after = receiveTypists(undefined, frame(3, [member("bo", 1)]));
		expect(typingWords(typersIn(after, { viewer: "me" }))).toBe("@bo is typing…");
	});
});

describe("what the live region says", () => {
	test("it speaks when who is writing in a place changes, and is silent for a new order, a repeat or a working row", () => {
		let ana = { kind: "member", handle: "ana" } as const;
		let bo = { kind: "member", handle: "bo" } as const;
		let chopin = { kind: "agent" } as const;
		let first = announcement(undefined, [ana, chopin]);
		expect(first.text).toBe("@ana and chopin are typing…");
		expect(announcement(first, [chopin, ana])).toBe(first);
		expect(announcement(first, [ana, chopin])).toBe(first);
		let joined = announcement(first, [ana, chopin, bo]);
		expect(joined.text).toBe("Several people are typing…");
		let left = announcement(joined, []);
		expect(left.text).toBe("");
		expect(announcement(left, [])).toBe(left);
	});

	test("with a thread open beside Chat, each part names its conversation", () => {
		let ana = { kind: "member", handle: "ana" } as const;
		expect(announcement(undefined, [ana], "In Chat").text).toBe("In Chat, @ana is typing…");
		expect(announcement(undefined, [ana], "In the thread").text)
			.toBe("In the thread, @ana is typing…");
		expect(announcement(undefined, [], "In Chat").text).toBe("");
		let unlabelled = announcement(undefined, [ana]);
		expect(announcement(unlabelled, [ana], "In Chat")).toBe(unlabelled);
	});

	test("a thread's row says replying for one, two, several, and people with chopin", () => {
		let ana = { kind: "member", handle: "ana" } as const;
		let bo = { kind: "member", handle: "bo" } as const;
		let cy = { kind: "member", handle: "cy" } as const;
		let chopin = { kind: "agent" } as const;
		expect(typingWords([ana], "replying")).toBe("@ana is replying…");
		expect(typingWords([ana, bo], "replying")).toBe("@ana and @bo are replying…");
		expect(typingWords([ana, chopin], "replying")).toBe("@ana and chopin are replying…");
		expect(typingWords([ana, bo, cy], "replying")).toBe("Several people are replying…");
		expect(typingWords([ana, bo, chopin], "replying")).toBe("Several people are replying…");
	});
});
