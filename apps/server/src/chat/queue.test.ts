/**
 * Turns that something other than a message started.
 *
 * Accepting a comment is an instruction, so it starts a turn the same way a
 * message does — through the same queue, with the same ceiling. What differs is
 * that a button press is not a thing anybody said, so the transcript has to be
 * told why the agent began moving, and that the work may already be done by the
 * time the turn comes up.
 */

import { describe, expect, it } from "bun:test";

import * as Chat from "./service";

import type { Server } from "bun";
import type { Config } from "../config";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

type Sent = { kind: string; [key: string]: unknown };

function room(options: { agent?: boolean; busy?: boolean } = {}) {
	let sent: Sent[] = [];
	let chat = Chat.create();
	chat.busy = options.busy ?? false;

	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Sent);
		},
	} as unknown as Server<SocketData>;

	let context: Chat.Room = {
		chat,
		config: { agent: options.agent ?? true } as Config,
		plan: { chat } as Plan,
		room: "test",
		server,
	};

	return { chat, context, sent };
}

/** What the transcript gained, in order. */
function said(sent: Sent[]): string[] {
	return sent
		.filter(frame => frame.kind === "chat:message")
		.map(frame => (frame.entry as { text: string }).text);
}

describe("instructing the agent without a message", () => {
	/**
	 * An agent that starts editing for no visible reason is worse than a noisy
	 * log, so the reason goes in the one place the room reads chronologically.
	 */
	it("says why the turn started", () => {
		let { context, sent } = room({ busy: true });
		Chat.instruct(context, "ana", "do the thing", '@ana accepted a comment on "x".');

		expect(said(sent)[0]).toBe('@ana accepted a comment on "x".');
	});

	it("queues behind a running turn rather than interrupting it", () => {
		let { chat, context, sent } = room({ busy: true });
		Chat.instruct(context, "ana", "do the thing", "@ana accepted a comment.");

		expect(chat.waiting).toHaveLength(1);
		expect(chat.waiting[0]).toMatchObject({ handle: "ana", text: "do the thing" });
		expect(sent.some(frame => frame.kind === "chat:queue")).toBe(true);
	});

	it("refuses to grow a queue nobody is going to read", () => {
		let { chat, context, sent } = room({ busy: true });
		for (let i = 0; i < 25; i++) {
			Chat.instruct(context, "ana", `turn ${i}`, `notice ${i}`);
		}

		expect(chat.waiting.length).toBeLessThanOrEqual(20);
		expect(said(sent)).toContain("The queue is full. Wait for the current turn to finish.");
	});

	/**
	 * `AGENT=off` runs the room without one. The decision that got here is
	 * already recorded; only the turn is impossible. Saying so beats a session
	 * failing to open — which is what happened before this check existed,
	 * because `chat:send` was gated and a button press was not.
	 */
	it("records the decision but does not reach for an agent that is off", () => {
		let { chat, context, sent } = room({ agent: false, busy: false });
		Chat.instruct(context, "ana", "do the thing", "@ana accepted a comment.");

		expect(chat.busy).toBe(false);
		expect(chat.waiting).toHaveLength(0);
		expect(said(sent)).toEqual([
			"@ana accepted a comment.",
			"The agent is not running, so the plan has not been revised.",
		]);
	});

	it("still says nothing was revised when the agent is off and busy", () => {
		let { chat, context, sent } = room({ agent: false, busy: true });
		Chat.instruct(context, "ana", "do the thing", "@ana accepted a comment.");

		// The gate comes before the queue: queueing a turn that can never run
		// would leave it there until someone withdrew it.
		expect(chat.waiting).toHaveLength(0);
		expect(said(sent)).toHaveLength(2);
	});
});

/** Queue some turns, as `instruct` would have while another was running. */
function waiting(chat: Chat.Chat, entries: Array<{ text: string; spent?: () => boolean }>): void {
	for (let [index, entry] of entries.entries()) {
		chat.waiting.push({ id: `w${index}`, handle: "ana", ...entry });
	}
}

describe("draining the queue", () => {
	it("takes them in the order they arrived", () => {
		let { chat } = room();
		waiting(chat, [{ text: "first" }, { text: "second" }]);

		expect(Chat.pending(chat)?.text).toBe("first");
		expect(Chat.pending(chat)?.text).toBe("second");
		expect(Chat.pending(chat)).toBeUndefined();
	});

	/**
	 * Four accepted comments should not cost four passes over the plan when the
	 * agent dealt with all of them in the first. Only something that queued
	 * behind a turn can be spent, which is why the question is asked here.
	 */
	it("drops a turn whose work another one already did", () => {
		let { chat } = room();
		waiting(chat, [
			{ text: "thread one", spent: () => true },
			{ text: "thread two", spent: () => true },
			{ text: "thread three", spent: () => false },
		]);

		expect(Chat.pending(chat)?.text).toBe("thread three");
		expect(chat.waiting).toHaveLength(0);
	});

	it("drops the whole queue when everything in it is spent", () => {
		let { chat } = room();
		waiting(chat, [{ text: "one", spent: () => true }, { text: "two", spent: () => true }]);

		expect(Chat.pending(chat)).toBeUndefined();
	});

	/** An ordinary message is never spent: nobody else can have said it for you. */
	it("keeps a message, which has no work anybody else could have done", () => {
		let { chat } = room();
		waiting(chat, [{ text: "what about auth?" }]);

		expect(Chat.pending(chat)?.text).toBe("what about auth?");
	});

	/**
	 * `spent` is a function, so it is asked at the moment the turn would run
	 * rather than when it was queued — which is the only moment the answer is
	 * knowable. It also means `JSON.stringify` drops it, keeping the wire shape
	 * exactly what clients expect.
	 */
	it("asks when the turn would run, not when it was queued", () => {
		let { chat } = room();
		let done = false;
		waiting(chat, [{ text: "thread", spent: () => done }]);

		done = true;
		expect(Chat.pending(chat)).toBeUndefined();
	});

	it("keeps `spent` off the wire", () => {
		let { context, sent } = room({ busy: true });
		Chat.instruct(context, "ana", "do the thing", "notice", () => false);

		let queue = sent.findLast(frame => frame.kind === "chat:queue");
		expect(queue?.waiting).toEqual([{
			id: expect.any(String),
			handle: "ana",
			text: "do the thing",
		}]);
	});
});
