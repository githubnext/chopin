import { describe, expect, it, spyOn } from "bun:test";
import { ulid } from "@chopin/dialect";

import {
	consumeBootstrapBackscroll,
	create,
	retainReferences,
	sessionBootstrap,
	translate,
} from "./service";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat, Room } from "./service";
import type { SocketData } from "../wire";
import type { Chat as Wire } from "@chopin/protocol";

function room(chat: Chat) {
	let sent: Array<Record<string, unknown>> = [];
	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Record<string, unknown>);
		},
	} as unknown as Server<SocketData>;
	return { sent, context: { chat, server, room: "test", plan: {}, config: {} } as Room };
}

function part(value: Record<string, unknown>): TextStreamPart<ToolSet> {
	return value as TextStreamPart<ToolSet>;
}

function call(toolName: string, toolCallId = "t1", input: unknown = {}) {
	return part({ type: "tool-call", toolCallId, toolName, input });
}

describe("AI SDK stream projection", () => {
	it("counts only non-empty Planner prose as a response and streams one entry", () => {
		let chat = create();
		chat.turn = { id: "turn-1", handle: "ana", started: 1_700_000_000, responded: false };
		let { context, sent } = room(chat);
		translate(context, call("read_plan"));
		translate(context, part({ type: "text-start", id: "message" }));
		translate(context, part({ type: "text-delta", id: "message", text: "  " }));
		expect(chat.turn.responded).toBe(false);
		translate(context, part({ type: "text-delta", id: "message", text: "Done." }));
		translate(context, part({ type: "text-end", id: "message" }));
		expect(chat.turn.responded).toBe(true);
		let entry = chat.entries.find(entry => entry.text === "  Done.");
		expect(entry?.streaming).toBeUndefined();
		expect(entry?.id).not.toBe("message");
		expect(sent.findLast(frame => frame.kind === "chat:delta")?.text).toBe("Done.");
	});

	it("keeps messages and reused adapter ids separate across turns", () => {
		let chat = create();
		let { context } = room(chat);
		translate(context, part({ type: "text-delta", id: "m1", text: "First." }));
		translate(context, part({ type: "text-end", id: "m1" }));
		let previous = chat.entries[0]!.id;
		chat.messageIds = new Map();
		translate(context, part({ type: "text-delta", id: "m1", text: "Second." }));
		translate(context, part({ type: "text-end", id: "m1" }));
		expect(chat.entries.map(entry => entry.text)).toEqual(["First.", "Second."]);
		expect(chat.entries[1]!.id).not.toBe(previous);
	});

	it("announces tool activity and bounds results", () => {
		let chat = create();
		let { context, sent } = room(chat);
		translate(context, call("read_plan", "t1", { revision: 1 }));
		expect(sent.map(frame => frame.kind)).toEqual(["chat:message", "chat:tool"]);
		translate(context, part({ type: "finish" }));
		translate(
			context,
			part({
				type: "tool-result",
				toolCallId: "t1",
				toolName: "read_plan",
				output: "x".repeat(20_000),
			}),
		);
		expect(chat.entries[0]?.tools?.[0]).toMatchObject({ id: "t1", status: "done" });
		expect(chat.entries[0]?.tools?.[0]?.result?.length).toBe(4_000);
	});

	it("never publishes referenced source content", () => {
		let chat = create();
		let { context } = room(chat);
		translate(context, call("read_reference"));
		translate(
			context,
			part({
				type: "tool-result",
				toolCallId: "t1",
				toolName: "read_reference",
				output: "PRIVATE SOURCE",
			}),
		);
		expect(chat.entries[0]?.tools?.[0]?.result).toBe(
			"Reference content was returned privately to the Planner.",
		);
		expect(JSON.stringify(chat.entries)).not.toContain("PRIVATE SOURCE");
	});

	it("marks tool errors and denied outputs failed", () => {
		let chat = create();
		let { context } = room(chat);
		translate(context, call("edit_plan"));
		translate(
			context,
			part({
				type: "tool-error",
				toolCallId: "t1",
				toolName: "edit_plan",
				error: "stale revision",
			}),
		);
		expect(chat.entries[0]?.tools?.[0]).toMatchObject({
			status: "failed",
			result: "stale revision",
		});
		translate(context, call("ask", "t2"));
		translate(context, part({ type: "tool-output-denied", toolCallId: "t2", toolName: "ask" }));
		expect(chat.entries[0]?.tools?.[1]).toMatchObject({ status: "failed", result: "Refused." });
	});

	it("aborts and logs an inactive tool call rather than projecting it", () => {
		let chat = create();
		let controller = chat.turnController = new AbortController();
		let { context } = room(chat);
		let error = spyOn(console, "error").mockImplementation(() => {});
		try {
			translate(context, call("bash"));
			expect(controller.signal.aborted).toBe(true);
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining("boundary failure: inactive tool bash"),
			);
			expect(chat.entries).toHaveLength(0);
		} finally {
			error.mockRestore();
		}
	});

	it("auto-denies an unexpected approval without waiting for a person", () => {
		let chat = create();
		let controller = chat.turnController = new AbortController();
		translate(
			room(chat).context,
			part({ type: "tool-approval-request", toolCallId: "t1", approvalId: "a1" }),
		);
		expect(controller.signal.aborted).toBe(true);
		expect(chat.interruption).toContain("approval was denied");
	});

	it("projects stream errors as system entries", () => {
		let chat = create();
		translate(room(chat).context, part({ type: "error", error: new Error("model unavailable") }));
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
