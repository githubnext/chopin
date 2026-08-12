/**
 * Turning SDK events into a transcript.
 *
 * Everything worth reading in these events lives under `data`, and several of
 * those fields have near-homonyms on the envelope around it — `id` beside
 * `data.messageId`, most consequentially. Reading the wrong one does not throw:
 * it produces a transcript that looks almost right, which is how a duplicated
 * message and a caret that never stopped blinking got as far as a screenshot.
 */

import { describe, expect, it } from "bun:test";

import { create, translate } from "./service";

import type { Server } from "bun";
import type { SessionEvent } from "@github/copilot-sdk";
import type { Chat } from "./service";
import type { Room } from "./service";
import type { SocketData } from "../wire";

/** Captures what would have gone to the room. */
function room(chat: Chat) {
	let sent: Array<Record<string, unknown>> = [];
	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Record<string, unknown>);
		},
	} as unknown as Server<SocketData>;

	return {
		sent,
		context: { chat, server, room: "test", plan: {}, config: {} } as unknown as Room,
	};
}

/** The envelope's id is deliberately never the message's. */
function delta(messageId: string, deltaContent: string): SessionEvent {
	return {
		type: "assistant.message_delta",
		id: `event-${Math.random().toString(36).slice(2, 8)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		data: { messageId, deltaContent },
	} as unknown as SessionEvent;
}

function finished(messageId: string, content: string): SessionEvent {
	return {
		type: "assistant.message",
		id: `event-${Math.random().toString(36).slice(2, 8)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		data: { messageId, content },
	} as unknown as SessionEvent;
}

function tool(
	type: "tool.execution_start" | "tool.execution_complete",
	data: Record<string, unknown>,
): SessionEvent {
	return {
		type,
		id: `event-${Math.random().toString(36).slice(2, 8)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		data,
	} as unknown as SessionEvent;
}

function idle(): SessionEvent {
	return {
		type: "session.idle",
		id: `event-${Math.random().toString(36).slice(2, 8)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		data: {},
	} as unknown as SessionEvent;
}

describe("a streamed message", () => {
	it("counts only non-empty Planner prose as the turn response", () => {
		let chat = create();
		chat.turn = {
			id: "turn-1",
			handle: "ana",
			started: 1_700_000_000,
			responded: false,
		};
		let { context } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "grep" }));
		expect(chat.turn?.responded).toBe(false);

		translate(context, delta("m1", "   "));
		expect(chat.turn?.responded).toBe(false);

		translate(context, delta("m1", "I found it."));
		expect(chat.turn?.responded).toBe(true);
	});

	it("becomes one entry, not one per event", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, delta("m1", "Hi "));
		translate(context, delta("m1", "there"));
		translate(context, finished("m1", "Hi there"));

		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]).toMatchObject({ id: "m1", text: "Hi there" });
	});

	/**
	 * The regression. The final event's envelope id is not the message id, so
	 * matching on it finds nothing and appends a duplicate — leaving the first
	 * copy streaming, because that is the branch that clears the flag.
	 */
	it("is finalised even though the event has an id of its own", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, delta("m1", "Hi"));
		expect(chat.entries[0]?.streaming).toBe(true);

		translate(context, finished("m1", "Hi"));

		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]?.streaming).toBeUndefined();
	});

	it("keeps two messages in one turn apart", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, delta("m1", "First."));
		translate(context, finished("m1", "First."));
		translate(context, delta("m2", "Second."));
		translate(context, finished("m2", "Second."));

		expect(chat.entries.map(entry => entry.text)).toEqual(["First.", "Second."]);
	});

	it("relays each fragment as it arrives, so the room sees it typed", () => {
		let chat = create();
		let { context, sent } = room(chat);

		translate(context, delta("m1", "Hi "));
		translate(context, delta("m1", "there"));

		let deltas = sent.filter(frame => frame.kind === "chat:delta");
		expect(deltas.map(frame => frame.text)).toEqual(["there"]);
		// The first fragment arrives with the entry itself rather than after it.
		expect(sent.find(frame => frame.kind === "chat:message")).toMatchObject({
			entry: { text: "Hi " },
		});
	});

	it("takes a reply that was never streamed", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, finished("m1", "Done."));

		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]).toMatchObject({ text: "Done.", id: "m1" });
	});

	it("ignores an empty final message rather than showing a blank turn", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, finished("m1", "   "));

		expect(chat.entries).toHaveLength(0);
	});
});

describe("tool calls", () => {
	it("announces a tool-only entry before updating it", () => {
		let chat = create();
		let { context, sent } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "grep" }));

		expect(sent.map(frame => frame.kind)).toEqual(["chat:message", "chat:tool"]);
		expect(sent[1]?.entry).toBe((sent[0]!.entry as { id: string }).id);
	});

	it("starts a fresh tool run after a turn goes idle", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "grep" }));
		translate(context, idle());
		translate(context, tool("tool.execution_start", { toolCallId: "t2", toolName: "edit_plan" }));

		expect(chat.entries).toHaveLength(2);
		expect(chat.entries.map(entry => entry.tools?.[0]?.name)).toEqual(["grep", "edit_plan"]);
	});

	it("settles an ask after the turn goes idle", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "ask" }));
		translate(context, idle());
		translate(
			context,
			tool("tool.execution_complete", {
				toolCallId: "t1",
				success: true,
				result: { content: "answered" },
			}),
		);

		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]?.tools).toEqual([
			expect.objectContaining({ id: "t1", name: "ask", status: "done" }),
		]);
	});

	it("files them under the message that made them, with a duration", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, delta("m1", "Looking."));
		translate(
			context,
			tool("tool.execution_start", {
				toolCallId: "t1",
				toolName: "read_plan",
				arguments: { revision: 1 },
			}),
		);
		translate(
			context,
			tool("tool.execution_complete", {
				toolCallId: "t1",
				success: true,
				result: { content: "ok" },
			}),
		);

		let tools = chat.entries[0]?.tools ?? [];
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ id: "t1", name: "read_plan", status: "done" });
		// The completion does not repeat the name; it is recovered from the start.
		expect(tools[0]?.took).toBeGreaterThanOrEqual(0);
	});

	it("shows work that starts before the agent has said anything", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "grep" }));

		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]?.tools?.[0]).toMatchObject({ name: "grep", status: "running" });
	});

	it("marks a failure as one", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "edit_plan" }));
		translate(
			context,
			tool("tool.execution_complete", {
				toolCallId: "t1",
				success: false,
				error: { message: "stale revision" },
			}),
		);

		expect(chat.entries[0]?.tools?.[0]).toMatchObject({ name: "edit_plan", status: "failed" });
	});

	it("bounds a result rather than sending a whole repository to every browser", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, tool("tool.execution_start", { toolCallId: "t1", toolName: "grep" }));
		translate(
			context,
			tool("tool.execution_complete", {
				toolCallId: "t1",
				success: true,
				result: { content: "x".repeat(20_000) },
			}),
		);

		expect(chat.entries[0]?.tools?.[0]?.result?.length).toBe(4_000);
	});
});

describe("failure", () => {
	it("says so in the transcript rather than only in a log", () => {
		let chat = create();
		let { context } = room(chat);

		translate(context, {
			type: "session.error",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			data: { message: "model unavailable" },
		} as unknown as SessionEvent);

		expect(chat.entries[0]).toMatchObject({
			author: { kind: "system" },
			text: "model unavailable",
		});
	});
});
