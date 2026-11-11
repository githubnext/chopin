import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
	deliveryOf,
	echoes,
	FAILED_LABEL,
	failureOf,
	keepOutbox,
	MARK_LABEL,
	nextToSend,
	outboxReducer,
	passing,
	refusalText,
	restoreOutbox,
} from "./delivery";

import type { Session } from "@chopin/protocol";
import type { Outgoing } from "./delivery";

let uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(n: number, extra: Partial<Outgoing> = {}): Outgoing {
	return {
		payload: { requestId: uuid(n), text: `@chopin message ${n}`, to: "planner" },
		handle: "ana",
		ts: 1_700_000_000 + n,
		...extra,
	};
}

function build(...items: Outgoing[]): readonly Outgoing[] {
	return items.reduce<readonly Outgoing[]>(
		(outbox, next) => outboxReducer(outbox, { kind: "add", item: next }),
		[],
	);
}

describe("the outbox", () => {
	test("keeps messages in the order they were sent and adds one request id once", () => {
		let outbox = build(item(1), item(2), item(1, { ts: 5 }));
		expect(outbox.map(entry => entry.payload.requestId)).toEqual([uuid(1), uuid(2)]);
		expect(outbox[0]!.ts).toBe(1_700_000_001);
	});

	test("sends the oldest message the server has not been told of, one at a time", () => {
		let outbox = build(item(1), item(2), item(3));
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(1));
		outbox = outboxReducer(outbox, { kind: "attempt", id: uuid(1) });
		outbox = outboxReducer(outbox, { kind: "acknowledge", id: uuid(1) });
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(2));
	});

	test("a refused message does not hold the rest back, and goes out again when asked", () => {
		let outbox = build(item(1), item(2));
		outbox = outboxReducer(outbox, { kind: "refuse", id: uuid(1), reason: "No." });
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(2));
		outbox = outboxReducer(outbox, { kind: "again", id: uuid(1) });
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(1));
		expect(outbox[0]!.failure).toBeUndefined();
	});

	test("a message the server had trouble with is not refused: it keeps its place, holds the ones behind it so they stay in order, and goes out again once the trouble may have passed", () => {
		let outbox = build(item(1), item(2), item(3));
		outbox = outboxReducer(outbox, { kind: "attempt", id: uuid(1) });
		outbox = outboxReducer(outbox, { kind: "trouble", id: uuid(1) });
		expect(outbox[0]!.failure).toBeUndefined();
		// Still the browser's own, sending, and not offered to the server ahead of the one it holds.
		expect(nextToSend(outbox)).toBeUndefined();
		let [echo] = echoes(outbox);
		expect(deliveryOf(echo!)).toBe("sending");
		outbox = outboxReducer(outbox, { kind: "recovered" });
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(1));
		// Nothing to clear changes nothing, so nothing is re-rendered.
		expect(outboxReducer(outbox, { kind: "recovered" })).toBe(outbox);
	});

	test("a refused message still does not hold the rest back, unlike one the server had trouble with, which waits for its turn", () => {
		let outbox = build(item(1), item(2));
		outbox = outboxReducer(outbox, { kind: "refuse", id: uuid(1), reason: "No." });
		outbox = outboxReducer(outbox, { kind: "trouble", id: uuid(2) });
		expect(nextToSend(outbox)).toBeUndefined();
		outbox = outboxReducer(outbox, { kind: "recovered" });
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(2));
	});

	test("a message the server has shown back is no longer the browser's own, so it is never drawn twice", () => {
		let outbox = build(item(1), item(2));
		outbox = outboxReducer(outbox, { kind: "seen", ids: [uuid(1), "someone-else"] });
		expect(echoes(outbox).map(entry => entry.id)).toEqual([uuid(2)]);
		// Nothing changed, so nothing is re-rendered.
		expect(outboxReducer(outbox, { kind: "seen", ids: ["unknown"] })).toBe(outbox);
	});

	test("a message is the server's by the id it answered with as well as the request id", () => {
		let outbox = build(item(1), item(2));
		outbox = outboxReducer(outbox, { kind: "attempt", id: uuid(1) });
		outbox = outboxReducer(outbox, { kind: "acknowledge", id: uuid(1), entryId: "accepted-1" });
		expect(
			outboxReducer(outbox, { kind: "seen", ids: ["accepted-1"] }).map(entry =>
				entry.payload.requestId
			),
		)
			.toEqual([uuid(2)]);
		expect(
			outboxReducer(outbox, { kind: "history", ids: ["accepted-1"] }).map(entry =>
				entry.payload.requestId
			),
		)
			.toEqual([uuid(2)]);
	});

	test("a fresh history drops what it holds and what the server had acknowledged but no longer has, and keeps what was never sent", () => {
		let outbox = build(item(1), item(2), item(3), item(4));
		outbox = outboxReducer(outbox, { kind: "attempt", id: uuid(2) });
		outbox = outboxReducer(outbox, { kind: "acknowledge", id: uuid(2) });
		outbox = outboxReducer(outbox, { kind: "attempt", id: uuid(3) });
		outbox = outboxReducer(outbox, { kind: "history", ids: [uuid(1)] });
		// 1 is in the history, 2 was acknowledged and is gone, 3 may have been lost on the way and is
		// sent again, 4 never left the browser.
		expect(outbox.map(entry => entry.payload.requestId)).toEqual([uuid(3), uuid(4)]);
	});

	test("deleting a message the server refused drops it from the browser, which is all that holds it", () => {
		let outbox = build(item(1), item(2));
		outbox = outboxReducer(outbox, { kind: "drop", id: uuid(1) });
		outbox = outboxReducer(outbox, { kind: "drop", id: "unknown" });
		expect(outbox.map(entry => entry.payload.requestId)).toEqual([uuid(2)]);
	});
});

describe("refusals of a send", () => {
	type Code = NonNullable<Session.Failure["code"]>;
	/**
	 * Every code the server can answer a send with, and whether the message is at fault. A code
	 * left out of this table does not compile, and one added to the protocol and left out fails the
	 * test below. A refusal with no code is final: the server says one only for a passing reason.
	 *
	 * What the server answers a send, by message, and why (the audit this table stands for; the
	 * server's own tests inject each failure they can reach):
	 * - passing, `temporarily-unavailable`: the room is busy with too many sends; the message could
	 *   not be saved; the Chat or the room is closing or being replaced; the open child could not be
	 *   looked up; a reference could not be looked up for storage's sake; a turn is only beginning or
	 *   finishing and has no session to give the message to just now; authorization is temporarily
	 *   unavailable; any failure the send itself threw.
	 * - final, no code: a request id that is invalid, reused with different content or in conflict;
	 *   a message that was deleted; an invalid destination, text, focus or reference (a reference the
	 *   server found at fault: malformed, outside this repository, or no longer there); an empty or
	 *   oversize message; a child that is not there; a document that is being deleted or archived;
	 *   authorization that expired; no write access.
	 * - final, `planner-not-attached`: no machine can take it now (none is attached, or its machine
	 *   is away), and nothing is kept for when one can.
	 * - final, `planner-busy`: a turn is running and cannot be given a message (its harness takes
	 *   none mid-run, or it is a background job's).
	 * Not sends, and so with no code of their own to read: a task draft and a comment note sent to
	 * Chopin have no outbox, say why in the page's own words and are pressed again.
	 */
	const CODES: Record<Code, "passing" | "final"> = {
		"planner-not-attached": "final",
		"planner-busy": "final",
		"temporarily-unavailable": "passing",
	};

	test("every code in the protocol is classified, and only a passing one is sent again", async () => {
		let source = await Bun.file(
			new URL("../../../../packages/protocol/index.d.ts", import.meta.url),
		)
			.text();
		let union = source.match(/export type Failure = [\s\S]*?code\?:([\s\S]*?);/)?.[1] ?? "";
		let declared = [...union.matchAll(/"([a-z-]+)"/g)].map(match => match[1]!).sort();
		expect(declared.length).toBeGreaterThan(0);
		expect(declared).toEqual(Object.keys(CODES).sort());
		for (let [code, kind] of Object.entries(CODES)) {
			expect(passing(code as Code), code).toBe(kind === "passing");
		}
		expect(passing(undefined)).toBe(false);
	});

	test("a message refused for a passing reason keeps its place and is sent again with the same request id once the trouble may have passed; a final refusal fails it", () => {
		let outbox = build(item(1), item(2));
		outbox = outboxReducer(outbox, { kind: "attempt", id: uuid(1) });
		// What the page does with the refusal, by its code.
		let answer = (code: Session.Failure["code"], id: string) =>
			outbox = outboxReducer(
				outbox,
				passing(code) ? { kind: "trouble", id } : { kind: "refuse", id, reason: "No." },
			);
		answer("temporarily-unavailable", uuid(1));
		expect(deliveryOf(echoes(outbox)[0]!)).toBe("sending");
		expect(nextToSend(outbox)).toBeUndefined();
		outbox = outboxReducer(outbox, { kind: "recovered" });
		let again = nextToSend(outbox)!;
		expect(again.payload.requestId).toBe(uuid(1));
		answer(undefined, again.payload.requestId);
		expect(deliveryOf(echoes(outbox)[0]!)).toBe("failed");
		expect(nextToSend(outbox)?.payload.requestId).toBe(uuid(2));
	});
});

describe("what a message shows", () => {
	test("an echo of the outbox says Sending, and a message the server has has no mark at all", () => {
		let [echo] = echoes(build(item(1)));
		expect(deliveryOf(echo!)).toBe("sending");
		expect(deliveryOf({})).toBeUndefined();
	});

	test("an echo draws the person's own message, to the machine, with its time and no references", () => {
		let [echo] = echoes(build(item(1)));
		expect(echo).toMatchObject({
			id: uuid(1),
			author: { kind: "member", handle: "ana" },
			text: "@chopin message 1",
			to: "planner",
			ts: 1_700_000_001,
			echo: true,
		});
	});

	test("a refused echo says Couldn't send, with the reason in plain words", () => {
		let outbox = outboxReducer(build(item(1)), {
			kind: "refuse",
			id: uuid(1),
			reason: "Chopin can't take messages while it works on this machine. Stop it to ask now.",
		});
		let [echo] = echoes(outbox);
		expect(deliveryOf(echo!)).toBe("failed");
		expect(failureOf(echo!)).toBe(
			"Chopin can't take messages while it works on this machine. Stop it to ask now.",
		);
		expect(failureOf({})).toBe("It could not be sent.");
	});

	test("no mark names a queue, a wait or a clock", () => {
		expect(Object.values(MARK_LABEL).join(" ")).not.toMatch(/queue|wait|clock|held/i);
	});
});

describe("the words", () => {
	// The ban on what a person reads: Chopin's own terms. "Decision" is a product noun and allowed.
	const INTERNAL = /planner|attach|detach|\bheld\b|@chopin/i;

	test("none of Chopin's own terms appear in any mark, reason or refusal", () => {
		let words = [
			...Object.values(MARK_LABEL),
			FAILED_LABEL,
			refusalText("planner-not-attached", "the Planner is disconnected"),
			refusalText(undefined, ""),
		];
		for (let text of words) expect(INTERNAL.test(text), text).toBe(false);
	});

	test("the mark and the failure are named plainly", () => {
		expect(MARK_LABEL).toEqual({ sending: "Sending" });
		expect(FAILED_LABEL).toBe("Couldn't send");
	});

	test("a refusal is shown as given, capitalised, bounded and ended; a missing machine says so plainly", () => {
		expect(refusalText(undefined, "chat references are unavailable")).toBe(
			"Chat references are unavailable.",
		);
		expect(refusalText(undefined, "x".repeat(300))).toHaveLength(120);
		expect(refusalText("planner-not-attached", "anything")).toBe(
			"No machine is connected to reply.",
		);
		// A machine that is only away says so, and what to do: the message was not kept.
		expect(
			refusalText(
				"planner-not-attached",
				"@mona's machine is offline, so this message wasn't sent. Send it again when it's back.",
			),
		).toBe(
			"@mona's machine is offline, so this message wasn't sent. Send it again when it's back.",
		);
		expect(
			refusalText(
				"planner-busy",
				"Chopin can't take messages while it works on this machine. Stop it to ask now.",
			),
		).toBe("Chopin can't take messages while it works on this machine. Stop it to ask now.");
	});
});

describe("the outbox across a reload", () => {
	let store = new Map<string, string>();
	let original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	beforeAll(() => {
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
				removeItem: (key: string) => void store.delete(key),
			},
		});
	});
	afterAll(() => {
		if (original) Object.defineProperty(globalThis, "sessionStorage", original);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	});
	afterEach(() => store.clear());

	test("keeps what the server has not taken and brings it back in order, for the same person only", () => {
		let outbox = outboxReducer(build(item(1), item(2), item(3)), {
			kind: "acknowledge",
			id: uuid(2),
		});
		outbox = outboxReducer(outbox, { kind: "refuse", id: uuid(3), reason: "No." });
		keepOutbox("room", "ana", outbox);
		expect(restoreOutbox("room", "ana").map(entry => entry.payload.requestId)).toEqual([uuid(1)]);
		expect(restoreOutbox("room", "bob")).toEqual([]);
		expect(restoreOutbox("other", "ana")).toEqual([]);
		keepOutbox("room", "ana", []);
		expect(restoreOutbox("room", "ana")).toEqual([]);
	});

	test("remembers which messages were put on the wire, so that a reload sends them again with the same request id", () => {
		// 1 was put on the wire and its answer never came; 2 never left the page.
		let outbox = outboxReducer(build(item(1), item(2)), { kind: "attempt", id: uuid(1) });
		keepOutbox("room", "ana", outbox);
		let restored = restoreOutbox("room", "ana");
		expect(restored.map(entry => entry.attempted)).toEqual([true, undefined]);
		// Whatever the flag says, a reload keeps no refusal and no trouble: those are not saved.
		expect(restored.every(entry => !entry.failure && !entry.trouble)).toBe(true);
	});

	test("leaves out anything malformed", () => {
		store.set("chopin:outbox:room:ana", JSON.stringify([{ payload: { text: 3 } }, "x", null]));
		expect(restoreOutbox("room", "ana")).toEqual([]);
		store.set("chopin:outbox:room:ana", "not json");
		expect(restoreOutbox("room", "ana")).toEqual([]);
	});
});
