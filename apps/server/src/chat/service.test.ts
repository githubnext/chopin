import { describe, expect, it, spyOn } from "bun:test";
import { ulid } from "@chopin/dialect";

import {
	consumeBootstrapBackscroll,
	create,
	documentRoom,
	finished,
	progressed,
	retainReferences,
	sessionBootstrap,
	translate,
} from "./service";

import { PLANNER_TOOL_NAMES } from "../harness/tool-names";

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

it("omits the visual request callback without a preview provider", () => {
	let { context } = room(create());
	expect(documentRoom(context).createVisualRequest).toBeUndefined();
});

it("offers the visual request callback only for a complete provider", () => {
	let { context } = room(create());
	context.visualPreview = {
		request: async () => ({ requestId: "test", state: "pending" }),
		publish: async () => {},
		resolve: async () => undefined,
	};
	expect(documentRoom(context).createVisualRequest).toBeFunction();
	context.visualPreview = { resolve: async () => undefined } as never;
	expect(documentRoom(context).createVisualRequest).toBeUndefined();
});

describe("AI SDK stream projection", () => {
	it("counts only non-empty Planner prose as a response and streams one entry", () => {
		let chat = create();
		chat.turn = {
			id: "turn-1",
			handle: "ana",
			started: 1_700_000_000,
			startedAt: 1_700_000_000_000,
			entryOffset: 0,
			responded: false,
		};
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
		expect(chat.entries[0]?.tools?.[1]).toMatchObject({
			status: "failed",
			refused: true,
			result: "Refused.",
		});
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

	it("keeps reasoning private to the Planner: no frame, no transcript entry", () => {
		let chat = create();
		chat.turn = {
			id: "turn-1",
			handle: "ana",
			started: 1,
			startedAt: 1_000,
			entryOffset: 0,
			responded: false,
		};
		let { context, sent } = room(chat);
		translate(context, part({ type: "reasoning-start", id: "r1" }));
		translate(context, part({ type: "reasoning-delta", id: "r1", text: "Weighing options." }));
		translate(context, part({ type: "reasoning-end", id: "r1" }));
		expect(sent).toEqual([]);
		expect(chat.entries).toHaveLength(0);
		expect(chat.turn.responded).toBe(false);
	});

	it("opens a running row when a tool's input starts and settles the same row with its duration", () => {
		let chat = create();
		let { context, sent } = room(chat);
		let before = Date.now();
		translate(context, part({ type: "tool-input-start", id: "t1", toolName: "read_plan" }));
		translate(context, part({ type: "tool-input-delta", id: "t1", delta: "{" }));
		expect(sent.map(frame => frame.kind)).toEqual(["chat:message", "chat:tool"]);
		let opened = chat.entries[0]!.tools![0]!;
		expect(opened).toMatchObject({ id: "t1", name: "read_plan", status: "running" });
		expect(opened.startedAt).toBeGreaterThanOrEqual(before);
		expect(opened.args).toBeUndefined();

		translate(context, call("read_plan", "t1", { revision: 2 }));
		translate(
			context,
			part({ type: "tool-result", toolCallId: "t1", toolName: "read_plan", output: "ok" }),
		);
		let tools = chat.entries[0]!.tools!;
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ status: "done", startedAt: opened.startedAt, result: "ok" });
		expect(tools[0]!.args).toContain("revision");
		expect(tools[0]!.took).toBeGreaterThanOrEqual(0);
	});

	it("settles a host tool with its own duration when the buffered result arrives at step end", async () => {
		let chat = create();
		let { context, sent } = room(chat);
		translate(context, part({ type: "tool-input-start", id: "t1", toolName: "read_plan" }));
		translate(context, call("read_plan", "t1"));
		await Bun.sleep(20);
		finished(context, "t1", "ok", true);
		let tool = chat.entries[0]!.tools![0]!;
		expect(tool).toMatchObject({ status: "done", result: "ok" });
		let took = tool.took!;
		expect(took).toBeGreaterThanOrEqual(15);

		await Bun.sleep(60);
		let frames = sent.length;
		translate(
			context,
			part({ type: "tool-result", toolCallId: "t1", toolName: "read_plan", output: "ok" }),
		);
		expect(sent).toHaveLength(frames);
		expect(chat.entries[0]!.tools![0]!.took).toBe(took);
	});

	it("settles an Atomic builtin at its own end and ignores the buffered step-end parts", async () => {
		let chat = create();
		chat.agent = {
			activeTools: ["bash"],
			stream: async () => undefined as never,
			destroy: async () => {},
		};
		let { context, sent } = room(chat);
		translate(
			context,
			part({ type: "tool-input-start", id: "b1", toolName: "bash", providerExecuted: true }),
		);
		translate(context, call("bash", "b1"));
		progressed(context, "b1", "hi");
		expect(chat.entries[0]!.tools![0]).toMatchObject({ status: "running", result: "hi" });
		await Bun.sleep(20);
		finished(context, "b1", "hi\n", true);
		let tool = chat.entries[0]!.tools![0]!;
		expect(tool).toMatchObject({ status: "done", result: "hi\n" });
		let took = tool.took!;
		expect(took).toBeGreaterThanOrEqual(15);

		await Bun.sleep(60);
		let frames = sent.length;
		translate(
			context,
			part({
				type: "tool-result",
				toolCallId: "b1",
				toolName: "bash",
				output: "hi",
				preliminary: true,
			}),
		);
		translate(
			context,
			part({ type: "tool-result", toolCallId: "b1", toolName: "bash", output: "hi\n" }),
		);
		progressed(context, "b1", "late");
		expect(sent).toHaveLength(frames);
		expect(chat.entries[0]!.tools![0]).toMatchObject({ status: "done", took, result: "hi\n" });
	});

	it("keeps a builtin done when its end arrived but the buffered result never does", () => {
		let chat = create();
		chat.agent = {
			activeTools: ["bash"],
			stream: async () => undefined as never,
			destroy: async () => {},
		};
		let { context } = room(chat);
		translate(
			context,
			part({ type: "tool-input-start", id: "b2", toolName: "bash", providerExecuted: true }),
		);
		finished(context, "b2", "out", true);
		expect(chat.entries[0]!.tools![0]).toMatchObject({ status: "done", result: "out" });
	});

	it("keeps a tool running through preliminary output and files later tools after later prose", () => {
		let chat = create();
		let { context } = room(chat);
		translate(context, call("read_plan", "t1"));
		translate(
			context,
			part({
				type: "tool-result",
				toolCallId: "t1",
				toolName: "read_plan",
				output: "partial",
				preliminary: true,
			}),
		);
		expect(chat.entries[0]!.tools![0]).toMatchObject({ status: "running", result: "partial" });
		expect(chat.entries[0]!.tools![0]!.took).toBeUndefined();
		translate(context, part({ type: "text-start", id: "m" }));
		translate(context, part({ type: "text-delta", id: "m", text: "Then this." }));
		translate(context, part({ type: "text-end", id: "m" }));
		translate(context, call("edit_plan", "t2"));
		expect(chat.entries.map(entry => entry.tools?.map(tool => tool.id))).toEqual([
			["t1"],
			undefined,
			["t2"],
		]);
	});

	it("masks secrets and bounds what a tool shows other members", () => {
		let chat = create();
		let { context } = room(chat);
		translate(context, call("read_plan", "t1", { token: "abc", path: "a" }));
		translate(
			context,
			part({
				type: "tool-result",
				toolCallId: "t1",
				toolName: "read_plan",
				output: `Bearer ${"s".repeat(30)} ghp_${"A".repeat(30)}`,
			}),
		);
		let tool = chat.entries[0]!.tools![0]!;
		expect(tool.args).toContain("[redacted]");
		expect(tool.args).not.toContain("abc");
		expect(tool.result).toBe("Bearer [redacted] [redacted]");
	});

	it.each(["stream", "host"])(
		"scrubs credentials in %s tool updates before publication and retention",
		mode => {
			let chat = create();
			let { context, sent } = room(chat);
			translate(context, call("read_plan"));
			let partial = "AWS_SECRET_ACCESS_KEY=synthetic-progress-314\nstatus=ready";
			if (mode === "host") progressed(context, "t1", partial);
			else {
				translate(
					context,
					part({
						type: "tool-result",
						toolCallId: "t1",
						toolName: "read_plan",
						output: partial,
						preliminary: true,
					}),
				);
			}
			expect(sent.findLast(frame => frame.kind === "chat:tool")?.activity).toMatchObject({
				status: "running",
				result: "AWS_SECRET_ACCESS_KEY=[redacted]\nstatus=ready",
			});
			let output = JSON.stringify({
				source: '{"password":"synthetic-final-314","region":"local"}',
			});
			if (mode === "host") finished(context, "t1", output, true);
			else {
				translate(
					context,
					part({
						type: "tool-result",
						toolCallId: "t1",
						toolName: "read_plan",
						output,
					}),
				);
			}
			let result = JSON.stringify({ source: '{"password":"[redacted]","region":"local"}' });
			expect(sent.findLast(frame => frame.kind === "chat:tool")?.activity).toMatchObject({
				status: "done",
				result,
			});
			expect(chat.entries[0]?.tools?.[0]?.result).toBe(result);
			expect(JSON.stringify(sent)).not.toContain("synthetic-progress-314");
			expect(JSON.stringify(sent)).not.toContain("synthetic-final-314");
			expect(JSON.stringify(chat.entries)).not.toContain("synthetic-final-314");
		},
	);

	it("accepts the tools of a full session's active set and rejects the rest", () => {
		let chat = create();
		chat.agent = {
			activeTools: ["read_plan", "bash", "workflow"],
			stream: async () => undefined as never,
			destroy: async () => {},
		};
		let controller = chat.turnController = new AbortController();
		let { context } = room(chat);
		translate(context, part({ type: "tool-input-start", id: "t1", toolName: "bash" }));
		translate(context, call("workflow", "t2"));
		expect(controller.signal.aborted).toBe(false);
		expect(chat.entries[0]!.tools!.map(tool => tool.name)).toEqual(["bash", "workflow"]);
		let error = spyOn(console, "error").mockImplementation(() => {});
		try {
			translate(context, call("subagent", "t3"));
			expect(controller.signal.aborted).toBe(true);
		} finally {
			error.mockRestore();
		}
	});

	it("keeps a fixed-profile session at the Planner tools, so an Atomic builtin still aborts", () => {
		let chat = create();
		chat.agent = {
			activeTools: PLANNER_TOOL_NAMES,
			stream: async () => undefined as never,
			destroy: async () => {},
		};
		let controller = chat.turnController = new AbortController();
		let error = spyOn(console, "error").mockImplementation(() => {});
		try {
			translate(room(chat).context, part({ type: "tool-input-start", id: "t1", toolName: "bash" }));
			expect(controller.signal.aborted).toBe(true);
			expect(chat.interruption).toContain("bash");
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
