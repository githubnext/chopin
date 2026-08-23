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
import { ulid } from "@chopin/dialect";

import {
	consumeBootstrapBackscroll,
	create,
	retainReferences,
	sessionBootstrap,
	translate,
} from "./service";

import type { Server } from "bun";
import type { SessionEvent } from "@github/copilot-sdk";
import type { Chat } from "./service";
import type { Room } from "./service";
import type { SocketData } from "../wire";
import type { Chat as Wire } from "@chopin/protocol";

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

	it("keeps read_reference content private while showing a fixed completion", () => {
		let chat = create();
		let { context } = room(chat);
		translate(
			context,
			tool("tool.execution_start", { toolCallId: "reference", toolName: "read_reference" }),
		);
		translate(
			context,
			tool("tool.execution_complete", {
				toolCallId: "reference",
				success: true,
				result: { content: "PRIVATE REFERENCED SOURCE" },
			}),
		);
		expect(chat.entries[0]?.tools?.[0]).toMatchObject({
			name: "read_reference",
			status: "done",
			result: "Reference content was returned privately to the Planner.",
		});
		expect(JSON.stringify(chat.entries)).not.toContain("PRIVATE REFERENCED SOURCE");
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

function chatReference(index: number): Wire.DocumentReference {
	let text = `#reference-${index}`;
	return {
		id: ulid(1_700_000_000_000 + index),
		kind: "document",
		start: 0,
		end: text.length,
		label: text,
		href: `/documents/owner/repository/reference-${index}`,
		repositoryId: "R_test",
		observedRevision: index,
		channelId: crypto.randomUUID(),
		observedSourceHash: `sha256:${index.toString(16).padStart(64, "0")}`,
	};
}

describe("Planner reference context", () => {
	it("rebuilds a bounded cache and catalog from the durable bootstrap slice", () => {
		let chat = create();
		let references = Array.from({ length: 60 }, (_, index) => chatReference(index));
		chat.entries = references.map((reference, index) => ({
			id: `entry-${index}`,
			author: { kind: "member", handle: "ana" },
			text: reference.label,
			ts: index,
			references: [reference],
		}));

		let prompt = sessionBootstrap(chat, 0, "", "a different current message");

		expect(chat.referenceCache.size).toBe(50);
		expect(chat.referenceCache.has(references[9]!.id)).toBe(false);
		expect(chat.referenceCache.has(references[10]!.id)).toBe(true);
		expect(chat.referenceCache.has(references[59]!.id)).toBe(true);
		expect(prompt).toContain("Reference catalog");
		expect(prompt).toContain(`[reference id: ${references[59]!.id}]`);
		expect(prompt).not.toContain(references[9]!.id);
		expect(prompt).toContain(references[59]!.id);
	});

	it("expires the oldest ids when current and backscroll references arrive", () => {
		let chat = create();
		let references = Array.from({ length: 51 }, (_, index) => chatReference(index));
		retainReferences(chat, references.slice(0, 50));
		retainReferences(chat, [references[50]!]);
		expect(chat.referenceCache.size).toBe(50);
		expect(chat.referenceCache.has(references[0]!.id)).toBe(false);
		expect(chat.referenceCache.has(references[50]!.id)).toBe(true);
	});

	it("does not cache references from durable entries outside the transcript character bound", () => {
		let chat = create();
		let old = chatReference(1);
		let recent = chatReference(2);
		chat.entries = [{
			id: "old",
			author: { kind: "member", handle: "ana" },
			text: `${old.label}${"x".repeat(50_000)}`,
			ts: 1,
			references: [old],
		}, {
			id: "recent",
			author: { kind: "member", handle: "bob" },
			text: recent.label,
			ts: 2,
			references: [recent],
		}];

		let prompt = sessionBootstrap(chat, 0, "", "different");
		expect(chat.referenceCache.has(old.id)).toBe(false);
		expect(chat.referenceCache.has(recent.id)).toBe(true);
		expect(prompt).not.toContain(old.id);
		expect(prompt).toContain(recent.id);
	});

	it("excludes only the authoritative current entry id and caches its references for the turn", () => {
		let chat = create();
		let earlier = chatReference(1);
		let current = { ...chatReference(2), label: earlier.label, end: earlier.end };
		chat.entries = [{
			id: "earlier",
			author: { kind: "member", handle: "ana" },
			text: earlier.label,
			ts: 1,
			references: [earlier],
		}, {
			id: "current",
			author: { kind: "member", handle: "ana" },
			text: current.label,
			ts: 2,
			references: [current],
		}];
		let prompt = sessionBootstrap(chat, 0, "", "current", [current]);
		expect(prompt).toContain(`@ana: ${earlier.label}`);
		expect(prompt).toContain(earlier.id);
		expect(prompt).not.toContain(current.id);
		expect(chat.referenceCache.has(earlier.id)).toBe(true);
		expect(chat.referenceCache.has(current.id)).toBe(true);
	});

	it("removes backscroll already delivered by a successful fresh-session bootstrap", () => {
		let chat = create();
		let reference = chatReference(1);
		chat.entries = [{
			id: "room-entry",
			author: { kind: "member", handle: "ana" },
			text: reference.label,
			ts: 1,
			references: [reference],
		}];
		chat.backscroll = [{
			entryId: "room-entry",
			handle: "ana",
			text: reference.label,
			references: [reference],
		}];
		let prompt = sessionBootstrap(chat, 0, "", "current-entry");
		expect(prompt?.match(new RegExp(reference.label, "g"))).toHaveLength(2);
		// Once in the annotated transcript and once in the catalog, never again as backscroll.
		consumeBootstrapBackscroll(chat);
		expect(chat.backscroll).toEqual([]);
	});
});
