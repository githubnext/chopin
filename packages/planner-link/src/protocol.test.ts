import { describe, expect, it } from "bun:test";

import { plannerLinkUrl, WIRE } from "./client";
import {
	encodeMessage,
	MAX_LINK_MESSAGE_BYTES,
	MAX_LINK_NOTE_LENGTH,
	parseClientMessage,
	parseServerMessage,
	PLANNER_LINK_PATH,
	PLANNER_LINK_VERSION,
	toolErrorSchema,
} from "./protocol";

describe("Planner link messages", () => {
	it("accepts each client message the protocol declares", () => {
		let messages = [
			{ type: "attach", version: PLANNER_LINK_VERSION, document: "https://chopin.test/o/r/d" },
			{ type: "started", session: "s" },
			{ type: "tools", session: "s", turn: "t", names: ["read"] },
			{ type: "part", session: "s", turn: "t", part: { type: "text-delta", id: "a", delta: "hi" } },
			{
				type: "part",
				session: "s",
				turn: "t",
				part: {
					type: "tool-call",
					toolCallId: "c",
					toolName: "read",
					input: "{}",
					providerExecuted: true,
				},
			},
			{
				type: "part",
				session: "s",
				turn: "t",
				part: {
					type: "finish",
					finishReason: { unified: "stop" },
					totalUsage: { inputTokens: {}, outputTokens: {} },
				},
			},
			{
				type: "host-tool-call",
				session: "s",
				turn: "t",
				toolCallId: "c",
				toolName: "read_plan",
				input: "{}",
			},
			{ type: "turn-end", session: "s", turn: "t", status: "aborted" },
			{
				type: "input-request",
				request: "r",
				session: "s",
				workflowRunId: "run",
				input: {
					method: "questionnaire",
					params: {
						questions: [{
							header: "H",
							question: "Q?",
							options: [{ label: "A", description: "" }],
						}],
					},
				},
			},
			{ type: "input-cancel", request: "r" },
			{ type: "runs", session: "s", active: [], paused: ["run"], cards: [] },
			{ type: "control-result", request: "r", ok: false, message: "no" },
			{ type: "detach" },
		];
		for (let message of messages) {
			expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message } as never);
		}
	});

	it("refuses text that is not JSON, binary frames, unknown types, and undeclared fields", () => {
		for (
			let raw of [
				"{",
				new Uint8Array([123, 125]),
				JSON.stringify({ type: "unknown" }),
				JSON.stringify({ type: "detach", extra: true }),
				JSON.stringify({ type: "started", session: "" }),
				JSON.stringify({ type: "started", session: "x".repeat(129) }),
				JSON.stringify({
					type: "part",
					session: "s",
					turn: "t",
					part: { type: "tool-call", toolCallId: "c", toolName: "read", input: "{}" },
				}),
				JSON.stringify({
					type: "part",
					session: "s",
					turn: "t",
					part: { type: "raw", rawValue: 1 },
				}),
			]
		) {
			expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: "malformed-message" });
		}
	});

	it("refuses a message over the size limit before parsing it", () => {
		let raw = JSON.stringify({ type: "detach", padding: "x".repeat(MAX_LINK_MESSAGE_BYTES) });
		expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: "message-too-large" });
		let wide = JSON.stringify({
			type: "part",
			session: "s",
			turn: "t",
			part: { type: "text-delta", id: "a", delta: "é".repeat(MAX_LINK_MESSAGE_BYTES / 2) },
		});
		expect(wide.length).toBeLessThan(MAX_LINK_MESSAGE_BYTES);
		expect(parseClientMessage(wide)).toMatchObject({ ok: false, code: "message-too-large" });
		expect(encodeMessage({ type: "destroy", session: "s".repeat(MAX_LINK_MESSAGE_BYTES) }))
			.toBeUndefined();
	});

	it("round-trips server messages and states its version", () => {
		let message = {
			type: "turn" as const,
			session: "s",
			turn: "t",
			prompt: "plan",
			tools: [{ name: "read_plan", inputSchema: { type: "object" } }],
			responseFormat: { type: "json" as const, schema: { type: "object" } },
		};
		expect(parseServerMessage(encodeMessage(message))).toEqual({ ok: true, message });
		expect(parseServerMessage(encodeMessage({
			type: "attached",
			version: PLANNER_LINK_VERSION,
			document: { id: "d", title: "T", repository: "o/r" },
		}))).toMatchObject({ ok: true });
	});

	it("carries a structured tool error in a failed tool-result and recognises its envelope", () => {
		let error = {
			error: {
				code: "no-repository-credential",
				kind: "NoRepositoryCredential",
				message: "No credential can read this repository.",
			},
		};
		let message = {
			type: "part" as const,
			session: "s",
			turn: "t",
			part: {
				type: "tool-result" as const,
				toolCallId: "c",
				toolName: "read",
				result: error,
				isError: true,
			},
		};
		expect(parseClientMessage(encodeMessage(message))).toEqual({ ok: true, message });
		expect(toolErrorSchema.parse(error)).toEqual(error);
		let plain = { error: { code: "stale-revision", message: "The document moved on." } };
		expect(toolErrorSchema.parse(plain)).toEqual(plain);
	});

	it("refuses a malformed tool error envelope but keeps any JSON as a tool result", () => {
		for (
			let malformed of [
				{ error: "plain text" },
				{ error: { message: "No code." } },
				{ error: { code: "", message: "Empty code." } },
				{ error: { code: "x".repeat(129), message: "Long code." } },
				{ error: { code: "c", message: "" } },
				{ error: { code: "c", message: "x".repeat(MAX_LINK_NOTE_LENGTH + 1) } },
				{ error: { code: "c", kind: 3, message: "Numeric kind." } },
				{ error: { code: "c", message: "Extra field.", stack: "at x" } },
				{ error: { code: "c", message: "Extra sibling." }, details: {} },
			]
		) {
			expect(toolErrorSchema.safeParse(malformed).success).toBe(false);
			expect(parseClientMessage(JSON.stringify({
				type: "part",
				session: "s",
				turn: "t",
				part: { type: "tool-result", toolCallId: "c", toolName: "read", result: malformed },
			}))).toMatchObject({ ok: true });
		}
	});

	it("gives the wire-only client the same constants the server enforces", async () => {
		expect(WIRE).toEqual({
			path: PLANNER_LINK_PATH,
			version: PLANNER_LINK_VERSION,
			maxMessageBytes: MAX_LINK_MESSAGE_BYTES,
			maxNoteLength: MAX_LINK_NOTE_LENGTH,
			malformedClose: 4400,
		});
		let source = await Bun.file(new URL("./client.ts", import.meta.url)).text();
		let imports = [...source.matchAll(/^import\s+(type\s+)?/gm)];
		expect(imports.every(match => match[1])).toBe(true);
	});

	it("derives the link URL from a Chopin origin", () => {
		expect(plannerLinkUrl("https://chopin.test/some/doc?x=1").href)
			.toBe("wss://chopin.test/planner-link");
		expect(plannerLinkUrl("http://127.0.0.1:8787").href).toBe("ws://127.0.0.1:8787/planner-link");
		expect(plannerLinkUrl("ws://127.0.0.1:1/custom").href).toBe("ws://127.0.0.1:1/custom");
		expect(() => plannerLinkUrl("ftp://chopin.test")).toThrow("http(s) or ws(s)");
	});
});
